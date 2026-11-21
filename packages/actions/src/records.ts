import { visibilityFromColumns, visibilityToColumns } from '@rpg/authorization';
import {
  entitySchema,
  Id,
  type Id as IdValue,
  type Metadata,
  SemanticOp,
  type Tag,
  Timestamp,
  type Version,
  type Visibility,
} from '@rpg/contracts';
import { type Static, Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { isOperationPath, type PlannedOperation, type StateChange } from './engine/state.ts';

/**
 * One accepted decision on one target (`_techspec.md`, `_db.md`). Immutable: `version` is always 1. The
 * envelope's `tags`, `metadata`, and `updated*` are derived by the codec. `acceptedAt` and `changes` come
 * from the authority, so a device row without them is one the authority has not accepted yet.
 */

export const EFFECT_RECORD_TYPE = 'effect_application';
export const ACTIONS_SYNC_FEATURE_ID = 'actions';
export const EFFECT_REPLICA_TABLE = 'effect_applications';
export const MAX_EFFECT_OPERATIONS = 64;
const MAX_REFERENCE = 128;

const Token = Type.String({ pattern: '^[a-z][a-z0-9_]{0,63}$' });
/** No control characters: PostgreSQL text refuses NUL, and a queued write must not fail on storage. */
const Reference = Type.String({
  minLength: 1,
  maxLength: MAX_REFERENCE,
  pattern: '^[^\\u0000-\\u001f]+$',
});

const Guard = Type.Union([
  Type.Object({ path: Type.String(), atLeast: Type.Integer() }, { additionalProperties: false }),
  Type.Object(
    {
      path: Type.String(),
      equals: Type.Union([Type.String(), Type.Integer(), Type.Boolean()]),
    },
    { additionalProperties: false },
  ),
]);

export const PlannedOperationSchema = Type.Object(
  { operation: SemanticOp, requires: Type.Optional(Guard) },
  { additionalProperties: false },
);

export const StateChangeSchema = Type.Object(
  { path: Type.String(), before: Type.Unknown(), after: Type.Unknown() },
  { additionalProperties: false },
);

export const EffectReplicaSchema = entitySchema(
  {
    type: Type.Literal(EFFECT_RECORD_TYPE),
    actorUserId: Id,
    targetClass: Token,
    targetId: Id,
    action: Type.Optional(Reference),
    outcome: Type.Optional(Reference),
    rollId: Type.Optional(Id),
    sessionId: Type.Optional(Id),
    operations: Type.Array(PlannedOperationSchema, {
      minItems: 1,
      maxItems: MAX_EFFECT_OPERATIONS,
    }),
    changes: Type.Array(StateChangeSchema),
    edited: Type.Boolean(),
    appliedAt: Timestamp,
    acceptedAt: Type.Optional(Timestamp),
  },
  { additionalProperties: false },
);

export type EffectRecord = {
  readonly id: IdValue;
  readonly campaignId: IdValue;
  readonly type: typeof EFFECT_RECORD_TYPE;
  readonly name: string;
  readonly tags: Static<typeof Tag>[];
  readonly metadata: Static<typeof Metadata>;
  readonly visibility: Visibility;
  readonly version: Static<typeof Version>;
  readonly createdAt: string;
  readonly createdBy: IdValue;
  readonly updatedAt: string;
  readonly updatedBy: IdValue;
  readonly deletedAt?: string;
  readonly actorUserId: IdValue;
  readonly targetClass: string;
  readonly targetId: IdValue;
  readonly action?: string;
  readonly outcome?: string;
  readonly rollId?: IdValue;
  readonly sessionId?: IdValue;
  readonly operations: readonly PlannedOperation[];
  readonly changes: readonly StateChange[];
  readonly edited: boolean;
  readonly appliedAt: string;
  readonly acceptedAt?: string;
};

export type EffectRecordDefect =
  | 'invalid_shape'
  | 'actor_mismatch'
  | 'immutable_fields'
  | 'invalid_operation'
  | 'authority_fields';

/** Everything checkable from the record alone, on the device and at the authority. */
export function checkEffectRecord(candidate: unknown): EffectRecordDefect | undefined {
  if (!Value.Check(EffectReplicaSchema, candidate)) return 'invalid_shape';
  const record = candidate as EffectRecord;
  if (Number.isNaN(new Date(record.appliedAt).getTime())) return 'invalid_shape';
  if (record.createdBy !== record.actorUserId || record.updatedBy !== record.actorUserId) {
    return 'actor_mismatch';
  }
  if (
    record.version !== 1 ||
    record.deletedAt !== undefined ||
    record.tags.length > 0 ||
    Object.keys(record.metadata).length > 0
  ) {
    return 'immutable_fields';
  }
  // Only the authority says what changed and when it was accepted.
  if (record.acceptedAt !== undefined || record.changes.length > 0) return 'authority_fields';
  for (const { operation, requires } of record.operations) {
    if (!isOperationPath(operation.path)) return 'invalid_operation';
    if (requires !== undefined && !isOperationPath(requires.path)) return 'invalid_operation';
    if (
      operation.op === 'delta' &&
      (!Number.isSafeInteger(operation.value) || operation.value === 0)
    ) {
      return 'invalid_operation';
    }
  }
  return undefined;
}

/* -------------------------------------------------------------------------- */
/* Device replica                                                             */
/* -------------------------------------------------------------------------- */

export const ACTIONS_REPLICA_TABLES = {
  effect_applications: {
    columns: {
      campaign_id: 'text',
      actor_user_id: 'text',
      target_class: 'text',
      target_id: 'text',
      action: 'text',
      outcome: 'text',
      roll_id: 'text',
      session_id: 'text',
      operations: 'text',
      changes: 'text',
      edited: 'integer',
      visibility_mode: 'text',
      visibility_targets: 'text',
      version: 'integer',
      applied_at: 'text',
      accepted_at: 'text',
    },
    indexes: {
      campaign_target: ['campaign_id', 'target_class', 'target_id'],
      campaign_session: ['campaign_id', 'session_id'],
    },
  },
} as const;

/** Approved replicated columns, `id` first (stream projection order). */
export function effectReplicaProjection(): string[] {
  return ['id', ...Object.keys(ACTIONS_REPLICA_TABLES.effect_applications.columns)];
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function timestamp(value: unknown): string | undefined {
  if (typeof value !== 'string' || value === '') return undefined;
  const parsed = new Date(value.includes('T') ? value : value.replace(' ', 'T'));
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function optional<K extends string>(key: K, value: unknown): { [P in K]?: string } {
  return (typeof value === 'string' && value !== '' ? { [key]: value } : {}) as {
    [P in K]?: string;
  };
}

/** A record's name is what it came from, else a generic label; never stored. */
export function effectDisplayName(action: string | undefined): string {
  return action ?? EFFECT_RECORD_TYPE;
}

export type EffectColumns = Readonly<Record<string, string | number | null>>;

/** A row that does not map to a valid record is `undefined`: never guessed, never applied. */
export const EFFECT_ROW_CODEC = {
  toRow(record: EffectRecord): EffectColumns {
    const visibility = visibilityToColumns(record.visibility);
    return {
      campaign_id: record.campaignId,
      actor_user_id: record.actorUserId,
      target_class: record.targetClass,
      target_id: record.targetId,
      action: record.action ?? null,
      outcome: record.outcome ?? null,
      roll_id: record.rollId ?? null,
      session_id: record.sessionId ?? null,
      operations: JSON.stringify(record.operations),
      changes: JSON.stringify(record.changes),
      edited: record.edited ? 1 : 0,
      visibility_mode: visibility.mode,
      visibility_targets: JSON.stringify(visibility.targets),
      version: record.version,
      applied_at: record.appliedAt,
      accepted_at: record.acceptedAt ?? null,
    };
  },
  fromRow(row: Readonly<Record<string, unknown>>): EffectRecord | undefined {
    const visibility = visibilityFromColumns(
      row.visibility_mode,
      parseJson(row.visibility_targets),
    );
    const appliedAt = timestamp(row.applied_at);
    const acceptedAt = timestamp(row.accepted_at);
    if (visibility === undefined || appliedAt === undefined) return undefined;
    const stamped = acceptedAt ?? appliedAt;
    const record = {
      id: row.id,
      campaignId: row.campaign_id,
      type: EFFECT_RECORD_TYPE,
      name: effectDisplayName(typeof row.action === 'string' ? row.action : undefined),
      tags: [],
      metadata: {},
      visibility,
      version: Number(row.version),
      createdAt: stamped,
      createdBy: row.actor_user_id,
      updatedAt: stamped,
      updatedBy: row.actor_user_id,
      actorUserId: row.actor_user_id,
      targetClass: row.target_class,
      targetId: row.target_id,
      ...optional('action', row.action),
      ...optional('outcome', row.outcome),
      ...optional('rollId', row.roll_id),
      ...optional('sessionId', row.session_id),
      operations: parseJson(row.operations),
      changes: parseJson(row.changes),
      edited: row.edited === 1 || row.edited === true,
      appliedAt,
      ...(acceptedAt === undefined ? {} : { acceptedAt }),
    };
    return Value.Check(EffectReplicaSchema, record)
      ? (record as unknown as EffectRecord)
      : undefined;
  },
};
