import { visibilityFromColumns, visibilityToColumns } from '@rpg/authorization';
import {
  type EntityEnvelope,
  entitySchema,
  Id,
  type Id as IdValue,
  Timestamp,
  type Visibility,
} from '@rpg/contracts';
import { type Static, Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { replayRoll } from './engine/evaluator.ts';
import { ROLL_LIMITS, type RollResult } from './engine/model.ts';
import { parseRoll } from './engine/parser.ts';

/**
 * A recorded roll (`PRD.md` s.21, `_techspec.md`). Rows are immutable (D-09): the envelope's `name`,
 * `tags`, `metadata`, and `updated*` are derived by the codec, and `version` is always 1.
 */

export const ROLL_RECORD_TYPE = 'dice_roll';
export const DICE_SYNC_FEATURE_ID = 'dice';
export const DICE_ROLL_REPLICA_TABLE = 'dice_rolls';
export const MAX_ROLL_REFERENCE_LENGTH = 128;
export const MAX_WHISPER_RECIPIENTS = 32;

/** FR-008: the value a roll carries. Enforcement is the standard Visibility it maps to (D-11). */
export const ROLL_VISIBILITIES = ['public', 'gm_only', 'player_only', 'blind', 'whisper'] as const;
export type RollVisibility = (typeof ROLL_VISIBILITIES)[number];

const SIGN = Type.Union([Type.Literal(1), Type.Literal(-1)]);
const DIE = Type.Union(
  ['d4', 'd6', 'd8', 'd10', 'd12', 'd20', 'd100', 'dF'].map((die) => Type.Literal(die)),
);
const WHOLE = Type.Integer();
const strict = { additionalProperties: false } as const;

/** Shape only: `replayRoll` proves the content (D-14). */
export const RollResultSchema = Type.Object(
  {
    terms: Type.Array(
      Type.Union([
        Type.Object(
          {
            kind: Type.Literal('dice'),
            sign: SIGN,
            die: DIE,
            faces: Type.Array(
              Type.Object(
                { value: WHOLE, kept: Type.Boolean(), success: Type.Optional(Type.Boolean()) },
                strict,
              ),
              { minItems: 1, maxItems: ROLL_LIMITS.totalDice },
            ),
            subtotal: WHOLE,
          },
          strict,
        ),
        Type.Object(
          { kind: Type.Literal('modifier'), sign: SIGN, value: Type.Integer({ minimum: 0 }) },
          strict,
        ),
        Type.Object(
          {
            kind: Type.Literal('input'),
            sign: SIGN,
            name: Type.String({ minLength: 1, maxLength: ROLL_LIMITS.nameLength }),
            value: WHOLE,
          },
          strict,
        ),
      ]),
      { minItems: 1, maxItems: ROLL_LIMITS.terms },
    ),
    natural: WHOLE,
    modified: WHOLE,
    successes: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  strict,
);

/** No control characters: PostgreSQL text refuses NUL, and a queued roll must not fail on storage. */
const Reference = Type.String({
  minLength: 1,
  maxLength: MAX_ROLL_REFERENCE_LENGTH,
  pattern: '^[^\u0000-\u001f]+$',
});

/** The device's whole record, as uploaded and as read from the replica. */
export const RollReplicaSchema = entitySchema(
  {
    type: Type.Literal(ROLL_RECORD_TYPE),
    actorUserId: Id,
    actorRef: Type.Optional(Reference),
    targetRef: Type.Optional(Reference),
    action: Type.Optional(Reference),
    sessionId: Type.Optional(Id),
    expression: Type.String({ minLength: 1, maxLength: ROLL_LIMITS.expressionLength }),
    inputs: Type.Record(Type.String({ minLength: 1, maxLength: ROLL_LIMITS.nameLength }), WHOLE),
    result: RollResultSchema,
    rollVisibility: Type.Union(ROLL_VISIBILITIES.map((value) => Type.Literal(value))),
    rolledAt: Timestamp,
  },
  { additionalProperties: false },
);
export type RollRecord = Static<typeof EntityEnvelope> & {
  readonly type: typeof ROLL_RECORD_TYPE;
  readonly actorUserId: IdValue;
  readonly actorRef?: string;
  readonly targetRef?: string;
  readonly action?: string;
  readonly sessionId?: IdValue;
  readonly expression: string;
  readonly inputs: Readonly<Record<string, number>>;
  readonly result: RollResult;
  readonly rollVisibility: RollVisibility;
  readonly rolledAt: string;
};

export type RollVisibilityError = 'invalid_recipients';

/**
 * D-11, the one mapping. `whisper` must name someone other than the actor; every other value takes
 * no recipient. Targets are sorted and unique, the feature 04 stored form.
 */
export function rollVisibilityToVisibility(
  value: RollVisibility,
  actorUserId: string,
  recipients: readonly string[] = [],
): Visibility | RollVisibilityError {
  const others = [...new Set(recipients)].filter((recipient) => recipient !== actorUserId);
  if (value === 'whisper') {
    if (others.length === 0 || others.length > MAX_WHISPER_RECIPIENTS) return 'invalid_recipients';
    return { mode: 'players', playerIds: [actorUserId, ...others].sort() };
  }
  if (recipients.length > 0) return 'invalid_recipients';
  switch (value) {
    case 'public':
      return { mode: 'everyone' };
    case 'player_only':
      return { mode: 'players', playerIds: [actorUserId] };
    default:
      return { mode: 'gm_only' };
  }
}

/** Whether the label and the stored Visibility say the same thing (also a database CHECK). */
export function rollVisibilityAgrees(
  value: RollVisibility,
  actorUserId: string,
  visibility: Visibility,
): boolean {
  switch (value) {
    case 'public':
      return visibility.mode === 'everyone';
    case 'gm_only':
    case 'blind':
      return visibility.mode === 'gm_only';
    case 'player_only':
      return (
        visibility.mode === 'players' &&
        visibility.playerIds.length === 1 &&
        visibility.playerIds[0] === actorUserId
      );
    case 'whisper':
      return (
        visibility.mode === 'players' &&
        visibility.playerIds.length >= 2 &&
        visibility.playerIds.length <= MAX_WHISPER_RECIPIENTS + 1 &&
        visibility.playerIds.includes(actorUserId) &&
        // The stored form: strictly ascending, as the database function requires.
        visibility.playerIds.every(
          (id, index, ids) => index === 0 || (ids[index - 1] as string) < id,
        )
      );
    default:
      return false;
  }
}

export type RollRecordDefect =
  | 'invalid_shape'
  | 'actor_mismatch'
  | 'immutable_fields'
  | 'visibility_mismatch'
  | 'not_replayable';

/**
 * Every rule a record must satisfy before anything stores it; run on the device and at the authority.
 * `replayRoll` proves the faces, totals, and flags come from this expression and these inputs (D-14).
 */
export function checkRollRecord(candidate: unknown): RollRecordDefect | undefined {
  if (!Value.Check(RollReplicaSchema, candidate)) return 'invalid_shape';
  const record = candidate as RollRecord;
  if (Number.isNaN(new Date(record.rolledAt).getTime())) return 'invalid_shape';
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
  if (!rollVisibilityAgrees(record.rollVisibility, record.actorUserId, record.visibility)) {
    return 'visibility_mismatch';
  }
  // Only what the expression names is stored, so a roll never keeps a value it did not use.
  const parsed = parseRoll(record.expression);
  if (
    !parsed.ok ||
    Object.keys(record.inputs).sort().join() !== parsed.value.inputs.join() ||
    !replayRoll(record.expression, record.inputs, record.result)
  ) {
    return 'not_replayable';
  }
  return undefined;
}

/* -------------------------------------------------------------------------- */
/* Device replica                                                             */
/* -------------------------------------------------------------------------- */

export type ReplicaColumnType = 'text' | 'integer' | 'real';

/**
 * Exactly the approved projection of the `authorized_rolls` stream: `SYNC_RULE_BINDINGS` is built from
 * this list, and the web app passes the table to the browser replica schema (`_db.md`).
 */
export const DICE_REPLICA_TABLES = {
  dice_rolls: {
    columns: {
      campaign_id: 'text',
      actor_user_id: 'text',
      actor_ref: 'text',
      target_ref: 'text',
      action: 'text',
      session_id: 'text',
      expression: 'text',
      inputs: 'text',
      result: 'text',
      natural_result: 'integer',
      modified_result: 'integer',
      roll_visibility: 'text',
      visibility_mode: 'text',
      visibility_targets: 'text',
      version: 'integer',
      rolled_at: 'text',
      created_at: 'text',
    },
    indexes: {
      campaign_rolled: ['campaign_id', 'rolled_at'],
      campaign_session: ['campaign_id', 'session_id'],
    },
  },
} as const satisfies Record<
  string,
  {
    readonly columns: Readonly<Record<string, ReplicaColumnType>>;
    readonly indexes?: Readonly<Record<string, readonly string[]>>;
  }
>;

/** Approved replicated columns, `id` first (stream projection order). */
export function diceReplicaProjection(): string[] {
  return ['id', ...Object.keys(DICE_REPLICA_TABLES.dice_rolls.columns)];
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

/** Provider text (`2026-10-29 10:00:00.123456Z`, offsets) to the contract `Timestamp`. */
function timestamp(value: unknown): string | undefined {
  if (typeof value !== 'string' || value === '') return undefined;
  const parsed = new Date(value.includes('T') ? value : value.replace(' ', 'T'));
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

export type RollRow = Readonly<Record<string, unknown>>;
export type RollColumns = Readonly<Record<string, string | number | null>>;

/** A record's name is what it was for, else what was rolled; never stored. */
export function rollDisplayName(action: string | undefined, expression: string): string {
  return action ?? expression;
}

/**
 * Device record and replica row. A row that does not map to a valid record is `undefined`: never
 * guessed, never shown. Text columns may arrive empty for an optional value, as null.
 */
export const ROLL_ROW_CODEC = {
  toRow(record: RollRecord): RollColumns {
    const visibility = visibilityToColumns(record.visibility);
    return {
      campaign_id: record.campaignId,
      actor_user_id: record.actorUserId,
      actor_ref: record.actorRef ?? null,
      target_ref: record.targetRef ?? null,
      action: record.action ?? null,
      session_id: record.sessionId ?? null,
      expression: record.expression,
      inputs: JSON.stringify(record.inputs),
      result: JSON.stringify(record.result),
      natural_result: record.result.natural,
      modified_result: record.result.modified,
      roll_visibility: record.rollVisibility,
      visibility_mode: visibility.mode,
      visibility_targets: JSON.stringify(visibility.targets),
      version: record.version,
      rolled_at: record.rolledAt,
      created_at: record.createdAt,
    };
  },
  fromRow(row: RollRow): RollRecord | undefined {
    const visibility = visibilityFromColumns(
      row.visibility_mode,
      parseJson(row.visibility_targets),
    );
    const createdAt = timestamp(row.created_at);
    const rolledAt = timestamp(row.rolled_at);
    if (visibility === undefined || createdAt === undefined || rolledAt === undefined) {
      return undefined;
    }
    const record = {
      id: row.id,
      campaignId: row.campaign_id,
      type: ROLL_RECORD_TYPE,
      name:
        typeof row.expression === 'string'
          ? rollDisplayName(optional(row.action), row.expression)
          : '',
      tags: [],
      metadata: {},
      visibility,
      version: Number(row.version),
      createdAt,
      createdBy: row.actor_user_id,
      updatedAt: createdAt,
      updatedBy: row.actor_user_id,
      actorUserId: row.actor_user_id,
      ...optionalField('actorRef', row.actor_ref),
      ...optionalField('targetRef', row.target_ref),
      ...optionalField('action', row.action),
      ...optionalField('sessionId', row.session_id),
      expression: row.expression,
      inputs: parseJson(row.inputs),
      result: parseJson(row.result),
      rollVisibility: row.roll_visibility,
      rolledAt,
    };
    return Value.Check(RollReplicaSchema, record) ? (record as unknown as RollRecord) : undefined;
  },
};

function optional(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function optionalField<K extends string>(key: K, value: unknown): { [P in K]?: string } {
  const text = optional(value);
  return (text === undefined ? {} : { [key]: text }) as { [P in K]?: string };
}
