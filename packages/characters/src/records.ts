import type { TargetState } from '@rpg/actions/engine';
import { visibilityFromColumns, visibilityToColumns } from '@rpg/authorization';
import { entitySchema, Id, type Id as IdValue, SystemRef, type Visibility } from '@rpg/contracts';
import { type Static, Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

/**
 * Feature 15 records (`_db.md`). A character's public state and its GM-only state are two rows (D-06), so a
 * player's replica can never hold the second. The envelope's `name` is derived from the state (D-10).
 */

export const CHARACTER_RECORD_TYPE = 'character';
export const CHARACTER_SECRET_RECORD_TYPE = 'character_secret';
export const CHARACTERS_SYNC_FEATURE_ID = 'characters';
export const CHARACTER_REPLICA_TABLE = 'characters';
export const CHARACTER_SECRET_REPLICA_TABLE = 'character_secrets';
/** Bound on a stored state, so a hostile upload cannot grow a row without limit. */
export const MAX_STATE_BYTES = 64 * 1024;

const State = Type.Object(
  {
    fields: Type.Record(Type.String(), Type.Unknown()),
    resources: Type.Record(Type.String(), Type.Unknown()),
    tracks: Type.Record(Type.String(), Type.Unknown()),
    conditions: Type.Record(Type.String(), Type.Unknown()),
    inventory: Type.Record(Type.String(), Type.Unknown()),
    slots: Type.Record(Type.String(), Type.Unknown()),
    entries: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);

export const CharacterReplicaSchema = entitySchema(
  {
    type: Type.Literal(CHARACTER_RECORD_TYPE),
    ownerUserId: Id,
    system: SystemRef,
    state: State,
  },
  { additionalProperties: false },
);

export type CharacterRecord = Omit<Static<typeof CharacterReplicaSchema>, 'state'> & {
  readonly state: TargetState;
};

export interface CharacterSecretRecord {
  readonly id: IdValue;
  readonly campaignId: IdValue;
  readonly state: TargetState;
  readonly version: number;
  readonly updatedAt: string;
  readonly deletedAt?: string;
}

export function isStateShape(value: unknown): value is TargetState {
  return (
    Value.Check(State, value) &&
    new TextEncoder().encode(JSON.stringify(value)).length <= MAX_STATE_BYTES
  );
}

/* -------------------------------------------------------------------------- */
/* Device replica                                                             */
/* -------------------------------------------------------------------------- */

const ENVELOPE = {
  campaign_id: 'text',
  owner_user_id: 'text',
  system_id: 'text',
  system_version: 'text',
  state: 'text',
  visibility_mode: 'text',
  visibility_targets: 'text',
  version: 'integer',
  created_at: 'text',
  updated_at: 'text',
  created_by: 'text',
  updated_by: 'text',
  deleted_at: 'text',
} as const;

export const CHARACTER_REPLICA_TABLES = {
  characters: { columns: ENVELOPE, indexes: { campaign: ['campaign_id'] } },
  character_secrets: {
    columns: {
      campaign_id: 'text',
      state: 'text',
      visibility_mode: 'text',
      visibility_targets: 'text',
      version: 'integer',
      updated_at: 'text',
      deleted_at: 'text',
    },
    indexes: { campaign: ['campaign_id'] },
  },
} as const;

export function characterReplicaProjection(table: keyof typeof CHARACTER_REPLICA_TABLES): string[] {
  return ['id', ...Object.keys(CHARACTER_REPLICA_TABLES[table].columns)];
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

export type CharacterColumns = Readonly<Record<string, string | number | null>>;

/** `name` is the caller's derived display name: the codec cannot know the schema. */
export function characterCodec(
  name: (record: Pick<CharacterRecord, 'system' | 'state'>) => string,
) {
  return {
    toRow(record: CharacterRecord): CharacterColumns {
      const visibility = visibilityToColumns(record.visibility);
      return {
        campaign_id: record.campaignId,
        owner_user_id: record.ownerUserId,
        system_id: record.system.systemId,
        system_version: record.system.version,
        state: JSON.stringify(record.state),
        visibility_mode: visibility.mode,
        visibility_targets: JSON.stringify(visibility.targets),
        version: record.version,
        created_at: record.createdAt,
        updated_at: record.updatedAt,
        created_by: record.createdBy,
        updated_by: record.updatedBy,
        deleted_at: record.deletedAt ?? null,
      };
    },
    fromRow(row: Readonly<Record<string, unknown>>): CharacterRecord | undefined {
      const visibility = visibilityFromColumns(
        row.visibility_mode,
        parseJson(row.visibility_targets),
      );
      const createdAt = timestamp(row.created_at);
      const updatedAt = timestamp(row.updated_at);
      const deletedAt =
        row.deleted_at === null || row.deleted_at === undefined
          ? undefined
          : timestamp(row.deleted_at);
      const state = parseJson(row.state);
      if (visibility === undefined || createdAt === undefined || updatedAt === undefined)
        return undefined;
      if (!isStateShape(state)) return undefined;
      const system = { systemId: row.system_id, version: row.system_version };
      const record = {
        id: row.id,
        campaignId: row.campaign_id,
        type: CHARACTER_RECORD_TYPE,
        name: 'Character',
        tags: [],
        metadata: {},
        visibility,
        version: Number(row.version),
        createdAt,
        createdBy: row.created_by,
        updatedAt,
        updatedBy: row.updated_by,
        ...(deletedAt === undefined ? {} : { deletedAt }),
        ownerUserId: row.owner_user_id,
        system,
        state,
      };
      if (!Value.Check(CharacterReplicaSchema, record)) return undefined;
      const typed = record as unknown as CharacterRecord;
      return { ...typed, name: name(typed) };
    },
  };
}

export function secretFromRow(
  row: Readonly<Record<string, unknown>>,
): CharacterSecretRecord | undefined {
  const state = parseJson(row.state);
  const updatedAt = timestamp(row.updated_at);
  if (typeof row.id !== 'string' || typeof row.campaign_id !== 'string') return undefined;
  if (!isStateShape(state) || updatedAt === undefined) return undefined;
  const deletedAt =
    row.deleted_at === null || row.deleted_at === undefined ? undefined : timestamp(row.deleted_at);
  return {
    id: row.id,
    campaignId: row.campaign_id,
    state,
    version: Number(row.version),
    updatedAt,
    ...(deletedAt === undefined ? {} : { deletedAt }),
  };
}

/** D-07: who reads a character. Fixed at creation; there is no reveal in P0. */
export function characterVisibility(ownerUserId: string): Visibility {
  return { mode: 'players', playerIds: [ownerUserId] };
}
