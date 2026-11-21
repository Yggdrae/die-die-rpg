import type { TargetState } from '@rpg/actions/engine';
import { visibilityFromColumns, visibilityToColumns } from '@rpg/authorization';
import { isStateShape } from '@rpg/characters';
import { entitySchema, Id, Timestamp, type Visibility } from '@rpg/contracts';
import { type Static, Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

/**
 * Feature 19 records (`_db.md`): an encounter, its GM notes (`gm_only`, a row of their own), its participants (each
 * with its own Visibility, carrying the label and the public conditions only), and an entity participant's instance
 * state (`gm_only`), so a player replica never holds enemy statistics (D-05).
 */

export const ENCOUNTERS_SYNC_FEATURE_ID = 'encounters';
export const ENCOUNTER_REPLICA_TABLE = 'encounters';
export const ENCOUNTER_NOTE_REPLICA_TABLE = 'encounter_gm_notes';
export const PARTICIPANT_REPLICA_TABLE = 'encounter_participants';
export const PARTICIPANT_STATE_REPLICA_TABLE = 'encounter_participant_states';

export const ENCOUNTER_RECORD_TYPE = 'encounter';
export const ENCOUNTER_NOTE_RECORD_TYPE = 'encounter_gm_note';
export const PARTICIPANT_RECORD_TYPE = 'encounter_participant';

export const ENCOUNTER_STATUSES = ['active', 'ended'] as const;
export type EncounterStatus = (typeof ENCOUNTER_STATUSES)[number];
export const SOURCE_KINDS = ['character', 'entity'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const MAX_NAME_LENGTH = 120;
export const MAX_ENVIRONMENT_LENGTH = 2_000;
export const MAX_ENCOUNTER_NOTES = 5_000;
export const MAX_PARTICIPANTS_PER_ADD = 20;

export const ENCOUNTER_VISIBILITY: Visibility = { mode: 'everyone' };
export const ENCOUNTER_NOTES_VISIBILITY: Visibility = { mode: 'gm_only' };
export const PARTICIPANT_STATE_VISIBILITY: Visibility = { mode: 'gm_only' };

const Name = Type.String({ minLength: 1, maxLength: MAX_NAME_LENGTH });
const Status = Type.Union(ENCOUNTER_STATUSES.map((status) => Type.Literal(status)));
const Kind = Type.Union(SOURCE_KINDS.map((kind) => Type.Literal(kind)));
const Conditions = Type.Record(Type.String({ maxLength: 64 }), Type.Number());

export const EncounterReplicaSchema = entitySchema(
  {
    type: Type.Literal(ENCOUNTER_RECORD_TYPE),
    name: Name,
    sessionId: Type.Optional(Id),
    status: Status,
    startedAt: Timestamp,
    endedAt: Type.Optional(Timestamp),
    environment: Type.String({ maxLength: MAX_ENVIRONMENT_LENGTH }),
    locationId: Type.Optional(Id),
  },
  { additionalProperties: false },
);
export type EncounterRecord = Static<typeof EncounterReplicaSchema>;

export const EncounterNoteReplicaSchema = entitySchema(
  {
    type: Type.Literal(ENCOUNTER_NOTE_RECORD_TYPE),
    body: Type.String({ maxLength: MAX_ENCOUNTER_NOTES }),
  },
  { additionalProperties: false },
);
export type EncounterNoteRecord = Static<typeof EncounterNoteReplicaSchema>;

export const ParticipantReplicaSchema = entitySchema(
  {
    type: Type.Literal(PARTICIPANT_RECORD_TYPE),
    name: Name,
    encounterId: Id,
    sourceKind: Kind,
    sourceId: Id,
    position: Type.Integer({ minimum: 0 }),
    conditions: Conditions,
  },
  { additionalProperties: false },
);
export type ParticipantRecord = Static<typeof ParticipantReplicaSchema>;

/** The instance state of an entity participant, read-only on the device (written by feature 11 only). */
export interface ParticipantStateRecord {
  readonly id: string;
  readonly campaignId: string;
  readonly state: TargetState;
  readonly version: number;
  readonly updatedAt: string;
  readonly deletedAt?: string;
}

function sameVisibility(left: Visibility, right: Visibility): boolean {
  const a = visibilityToColumns(left);
  const b = visibilityToColumns(right);
  return a.mode === b.mode && a.targets.join(',') === b.targets.join(',');
}

/** `_db.md` shape rules a valid encounter satisfies, beyond its schema. */
export function isValidEncounter(candidate: unknown): candidate is EncounterRecord {
  if (!Value.Check(EncounterReplicaSchema, candidate)) return false;
  const record = candidate as EncounterRecord;
  if (record.name.trim() === '') return false;
  if (!sameVisibility(record.visibility, ENCOUNTER_VISIBILITY)) return false;
  if ((record.status === 'ended') !== (record.endedAt !== undefined)) return false;
  return record.endedAt === undefined || Date.parse(record.endedAt) >= Date.parse(record.startedAt);
}

export function isValidEncounterNote(candidate: unknown): candidate is EncounterNoteRecord {
  return (
    Value.Check(EncounterNoteReplicaSchema, candidate) &&
    sameVisibility((candidate as EncounterNoteRecord).visibility, ENCOUNTER_NOTES_VISIBILITY)
  );
}

/** D-05: a participant is `everyone` or `gm_only`; only an entity participant carries public conditions. */
export function isValidParticipant(candidate: unknown): candidate is ParticipantRecord {
  if (!Value.Check(ParticipantReplicaSchema, candidate)) return false;
  const record = candidate as ParticipantRecord;
  if (record.name.trim() === '') return false;
  const visibility = visibilityToColumns(record.visibility);
  if (!['everyone', 'gm_only'].includes(visibility.mode) || visibility.targets.length > 0) {
    return false;
  }
  return record.sourceKind === 'entity' || Object.keys(record.conditions).length === 0;
}

/* -------------------------------------------------------------------------- */
/* Device replica                                                             */
/* -------------------------------------------------------------------------- */

const STANDARD = {
  visibility_mode: 'text',
  visibility_targets: 'text',
  version: 'integer',
  created_at: 'text',
  updated_at: 'text',
  created_by: 'text',
  updated_by: 'text',
  deleted_at: 'text',
} as const;

/** Exactly the approved projection of stream `authorized_encounters`. */
export const ENCOUNTER_REPLICA_TABLES = {
  encounters: {
    columns: {
      campaign_id: 'text',
      session_id: 'text',
      name: 'text',
      status: 'text',
      started_at: 'text',
      ended_at: 'text',
      environment: 'text',
      location_id: 'text',
      ...STANDARD,
    },
    indexes: { campaign: ['campaign_id'] },
  },
  encounter_gm_notes: {
    columns: { campaign_id: 'text', body: 'text', ...STANDARD },
    indexes: { campaign: ['campaign_id'] },
  },
  encounter_participants: {
    columns: {
      campaign_id: 'text',
      encounter_id: 'text',
      label: 'text',
      source_kind: 'text',
      source_id: 'text',
      position: 'integer',
      conditions: 'text',
      ...STANDARD,
    },
    indexes: { campaign_encounter: ['campaign_id', 'encounter_id'] },
  },
  encounter_participant_states: {
    columns: { campaign_id: 'text', state: 'text', ...STANDARD },
    indexes: { campaign: ['campaign_id'] },
  },
} as const;

export function encounterReplicaProjection(table: keyof typeof ENCOUNTER_REPLICA_TABLES): string[] {
  return ['id', ...Object.keys(ENCOUNTER_REPLICA_TABLES[table].columns)];
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

/** Provider text (`2026-11-03 10:00:00.123Z`, offsets) to the contract `Timestamp`. */
function timestamp(value: unknown): string | undefined {
  if (typeof value !== 'string' || value === '') return undefined;
  const parsed = new Date(value.includes('T') ? value : value.replace(' ', 'T'));
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function optional<K extends string>(key: K, value: unknown): Partial<Record<K, unknown>> {
  return value === null || value === undefined || value === ''
    ? {}
    : ({ [key]: value } as Record<K, unknown>);
}

export type EncounterColumns = Readonly<Record<string, string | number | null>>;
type Row = Readonly<Record<string, unknown>>;

function envelopeColumns(record: {
  readonly campaignId: string;
  readonly visibility: Visibility;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly createdBy: string;
  readonly updatedBy: string;
  readonly deletedAt?: string;
}): EncounterColumns {
  const visibility = visibilityToColumns(record.visibility);
  return {
    campaign_id: record.campaignId,
    visibility_mode: visibility.mode,
    visibility_targets: JSON.stringify(visibility.targets),
    version: record.version,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    created_by: record.createdBy,
    updated_by: record.updatedBy,
    deleted_at: record.deletedAt ?? null,
  };
}

function envelopeFrom(row: Row, type: string, name: unknown): Record<string, unknown> | undefined {
  const visibility = visibilityFromColumns(row.visibility_mode, parseJson(row.visibility_targets));
  const createdAt = timestamp(row.created_at);
  const updatedAt = timestamp(row.updated_at);
  if (visibility === undefined || createdAt === undefined || updatedAt === undefined) {
    return undefined;
  }
  const deletedAt = timestamp(row.deleted_at);
  return {
    id: row.id,
    campaignId: row.campaign_id,
    type,
    name,
    tags: [],
    metadata: {},
    visibility,
    version: Number(row.version),
    createdAt,
    createdBy: row.created_by,
    updatedAt,
    updatedBy: row.updated_by,
    ...(deletedAt === undefined ? {} : { deletedAt }),
  };
}

export const ENCOUNTER_ROW_CODEC = {
  toRow(record: EncounterRecord): EncounterColumns {
    return {
      ...envelopeColumns(record),
      session_id: record.sessionId ?? null,
      name: record.name,
      status: record.status,
      started_at: record.startedAt,
      ended_at: record.endedAt ?? null,
      environment: record.environment,
      location_id: record.locationId ?? null,
    };
  },
  fromRow(row: Row): EncounterRecord | undefined {
    const envelope = envelopeFrom(row, ENCOUNTER_RECORD_TYPE, row.name);
    const startedAt = timestamp(row.started_at);
    if (envelope === undefined || startedAt === undefined) return undefined;
    const endedAt = timestamp(row.ended_at);
    const record = {
      ...envelope,
      ...optional('sessionId', row.session_id),
      status: row.status,
      startedAt,
      ...(endedAt === undefined ? {} : { endedAt }),
      environment: typeof row.environment === 'string' ? row.environment : '',
      ...optional('locationId', row.location_id),
    };
    return isValidEncounter(record) ? record : undefined;
  },
};

export const ENCOUNTER_NOTE_ROW_CODEC = {
  toRow(record: EncounterNoteRecord): EncounterColumns {
    return { ...envelopeColumns(record), body: record.body };
  },
  fromRow(row: Row): EncounterNoteRecord | undefined {
    const envelope = envelopeFrom(row, ENCOUNTER_NOTE_RECORD_TYPE, 'GM notes');
    if (envelope === undefined) return undefined;
    const record = { ...envelope, body: typeof row.body === 'string' ? row.body : undefined };
    return isValidEncounterNote(record) ? record : undefined;
  },
};

export const PARTICIPANT_ROW_CODEC = {
  toRow(record: ParticipantRecord): EncounterColumns {
    return {
      ...envelopeColumns(record),
      encounter_id: record.encounterId,
      label: record.name,
      source_kind: record.sourceKind,
      source_id: record.sourceId,
      position: record.position,
      conditions: JSON.stringify(record.conditions),
    };
  },
  fromRow(row: Row): ParticipantRecord | undefined {
    const envelope = envelopeFrom(row, PARTICIPANT_RECORD_TYPE, row.label);
    if (envelope === undefined) return undefined;
    const record = {
      ...envelope,
      encounterId: row.encounter_id,
      sourceKind: row.source_kind,
      sourceId: row.source_id,
      position: Number(row.position),
      conditions: parseJson(row.conditions),
    };
    return isValidParticipant(record) ? record : undefined;
  },
};

export function participantStateFromRow(row: Row): ParticipantStateRecord | undefined {
  const state = parseJson(row.state);
  const updatedAt = timestamp(row.updated_at);
  if (typeof row.id !== 'string' || typeof row.campaign_id !== 'string') return undefined;
  if (!isStateShape(state) || updatedAt === undefined) return undefined;
  const deletedAt = timestamp(row.deleted_at);
  return {
    id: row.id,
    campaignId: row.campaign_id,
    state,
    version: Number(row.version),
    updatedAt,
    ...(deletedAt === undefined ? {} : { deletedAt }),
  };
}
