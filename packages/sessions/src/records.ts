import { visibilityFromColumns, visibilityToColumns } from '@rpg/authorization';
import { entitySchema, Id, Timestamp, type Visibility } from '@rpg/contracts';
import { type Static, Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

/**
 * Feature 18 records (`_db.md`): a session, its GM notes (a row of their own, `gm_only`, so a player replica never
 * holds them), and immutable log entries with their own Visibility.
 */

export const SESSIONS_SYNC_FEATURE_ID = 'sessions';
export const SESSION_REPLICA_TABLE = 'campaign_sessions';
export const SESSION_NOTE_REPLICA_TABLE = 'session_gm_notes';
export const SESSION_LOG_REPLICA_TABLE = 'session_log_entries';

export const SESSION_RECORD_TYPE = 'session';
export const SESSION_NOTE_RECORD_TYPE = 'session_gm_note';
export const SESSION_LOG_RECORD_TYPE = 'session_log_entry';

export const SESSION_STATUSES = ['active', 'paused', 'ended'] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];
export const LOG_KINDS = ['note', 'scene', 'status', 'reveal'] as const;
export type LogKind = (typeof LOG_KINDS)[number];
export const STATUS_EVENTS = ['started', 'paused', 'resumed', 'ended'] as const;
export type StatusEvent = (typeof STATUS_EVENTS)[number];

export const MAX_PARTICIPANTS = 64;
export const MAX_NOTES_LENGTH = 20_000;
export const MAX_LOG_TEXT = 500;

export const SESSION_VISIBILITY: Visibility = { mode: 'everyone' };
export const NOTES_VISIBILITY: Visibility = { mode: 'gm_only' };

const Status = Type.Union(SESSION_STATUSES.map((status) => Type.Literal(status)));
const Kind = Type.Union(LOG_KINDS.map((kind) => Type.Literal(kind)));

export const SessionReplicaSchema = entitySchema(
  {
    type: Type.Literal(SESSION_RECORD_TYPE),
    number: Type.Integer({ minimum: 1 }),
    status: Status,
    startedAt: Timestamp,
    endedAt: Type.Optional(Timestamp),
    currentSceneId: Type.Optional(Id),
    participantUserIds: Type.Array(Id, { uniqueItems: true, maxItems: MAX_PARTICIPANTS }),
  },
  { additionalProperties: false },
);
export type SessionRecord = Static<typeof SessionReplicaSchema>;

export const SessionNoteReplicaSchema = entitySchema(
  {
    type: Type.Literal(SESSION_NOTE_RECORD_TYPE),
    body: Type.String({ maxLength: MAX_NOTES_LENGTH }),
  },
  { additionalProperties: false },
);
export type SessionNoteRecord = Static<typeof SessionNoteReplicaSchema>;

export const SessionLogEntryReplicaSchema = entitySchema(
  {
    type: Type.Literal(SESSION_LOG_RECORD_TYPE),
    sessionId: Id,
    kind: Kind,
    text: Type.String({ maxLength: MAX_LOG_TEXT }),
    subjectId: Type.Optional(Id),
  },
  { additionalProperties: false },
);
export type SessionLogEntryRecord = Static<typeof SessionLogEntryReplicaSchema>;

function sameVisibility(left: Visibility, right: Visibility): boolean {
  const a = visibilityToColumns(left);
  const b = visibilityToColumns(right);
  return a.mode === b.mode && a.targets.join(',') === b.targets.join(',');
}

/** `_db.md` shape rules a valid session satisfies, beyond its schema. */
export function isValidSession(candidate: unknown): candidate is SessionRecord {
  if (!Value.Check(SessionReplicaSchema, candidate)) return false;
  const record = candidate as SessionRecord;
  if (!sameVisibility(record.visibility, SESSION_VISIBILITY)) return false;
  if ((record.status === 'ended') !== (record.endedAt !== undefined)) return false;
  return record.endedAt === undefined || Date.parse(record.endedAt) >= Date.parse(record.startedAt);
}

export function isValidNote(candidate: unknown): candidate is SessionNoteRecord {
  return (
    Value.Check(SessionNoteReplicaSchema, candidate) &&
    sameVisibility((candidate as SessionNoteRecord).visibility, NOTES_VISIBILITY)
  );
}

/**
 * D-10: a note has text; a scene names its subject only; a status is one of the four events; a reveal made from
 * Session Mode names what was revealed and stays GM-only (the recipients see the content itself).
 */
export function isValidLogEntry(candidate: unknown): candidate is SessionLogEntryRecord {
  if (!Value.Check(SessionLogEntryReplicaSchema, candidate)) return false;
  const entry = candidate as SessionLogEntryRecord;
  const mode = entry.visibility.mode;
  if (mode !== 'gm_only' && mode !== 'everyone') return false;
  switch (entry.kind) {
    case 'note':
      return entry.text.trim() !== '' && entry.subjectId === undefined;
    case 'scene':
      return entry.text === '' && entry.subjectId !== undefined && mode === 'everyone';
    case 'status':
      return (
        (STATUS_EVENTS as readonly string[]).includes(entry.text) &&
        entry.subjectId === undefined &&
        mode === 'everyone'
      );
    case 'reveal':
      return entry.text === '' && entry.subjectId !== undefined && mode === 'gm_only';
    default:
      return false;
  }
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

/** Exactly the approved projection of stream `authorized_sessions` (`SYNC_RULE_BINDINGS` is built from it). */
export const SESSION_REPLICA_TABLES = {
  campaign_sessions: {
    columns: {
      campaign_id: 'text',
      number: 'integer',
      status: 'text',
      started_at: 'text',
      ended_at: 'text',
      current_scene_id: 'text',
      participant_user_ids: 'text',
      ...STANDARD,
    },
    indexes: { campaign: ['campaign_id'] },
  },
  session_gm_notes: {
    columns: { campaign_id: 'text', body: 'text', ...STANDARD },
    indexes: { campaign: ['campaign_id'] },
  },
  session_log_entries: {
    columns: {
      campaign_id: 'text',
      session_id: 'text',
      kind: 'text',
      text: 'text',
      subject_id: 'text',
      ...STANDARD,
    },
    indexes: { campaign_session: ['campaign_id', 'session_id'] },
  },
} as const;

export function sessionReplicaProjection(table: keyof typeof SESSION_REPLICA_TABLES): string[] {
  return ['id', ...Object.keys(SESSION_REPLICA_TABLES[table].columns)];
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

export type SessionColumns = Readonly<Record<string, string | number | null>>;
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
}): SessionColumns {
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

function envelopeFrom(row: Row, type: string, name: string): Record<string, unknown> | undefined {
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

export function sessionName(number: number): string {
  return `Session ${number}`;
}

export const SESSION_ROW_CODEC = {
  toRow(record: SessionRecord): SessionColumns {
    return {
      ...envelopeColumns(record),
      number: record.number,
      status: record.status,
      started_at: record.startedAt,
      ended_at: record.endedAt ?? null,
      current_scene_id: record.currentSceneId ?? null,
      participant_user_ids: JSON.stringify(record.participantUserIds),
    };
  },
  fromRow(row: Row): SessionRecord | undefined {
    const number = Number(row.number);
    const envelope = envelopeFrom(row, SESSION_RECORD_TYPE, sessionName(number));
    const startedAt = timestamp(row.started_at);
    if (envelope === undefined || startedAt === undefined) return undefined;
    const endedAt = timestamp(row.ended_at);
    const record = {
      ...envelope,
      number,
      status: row.status,
      startedAt,
      ...(endedAt === undefined ? {} : { endedAt }),
      ...optional('currentSceneId', row.current_scene_id),
      participantUserIds: parseJson(row.participant_user_ids),
    };
    return isValidSession(record) ? record : undefined;
  },
};

export const SESSION_NOTE_ROW_CODEC = {
  toRow(record: SessionNoteRecord): SessionColumns {
    return { ...envelopeColumns(record), body: record.body };
  },
  fromRow(row: Row): SessionNoteRecord | undefined {
    const envelope = envelopeFrom(row, SESSION_NOTE_RECORD_TYPE, 'GM notes');
    if (envelope === undefined) return undefined;
    const record = { ...envelope, body: typeof row.body === 'string' ? row.body : undefined };
    return isValidNote(record) ? record : undefined;
  },
};

export const SESSION_LOG_ROW_CODEC = {
  toRow(record: SessionLogEntryRecord): SessionColumns {
    return {
      ...envelopeColumns(record),
      session_id: record.sessionId,
      kind: record.kind,
      text: record.text,
      subject_id: record.subjectId ?? null,
    };
  },
  fromRow(row: Row): SessionLogEntryRecord | undefined {
    const envelope = envelopeFrom(
      row,
      SESSION_LOG_RECORD_TYPE,
      typeof row.kind === 'string' && row.kind !== '' ? row.kind : 'entry',
    );
    if (envelope === undefined) return undefined;
    const record = {
      ...envelope,
      sessionId: row.session_id,
      kind: row.kind,
      text: typeof row.text === 'string' ? row.text : undefined,
      ...optional('subjectId', row.subject_id),
    };
    return isValidLogEntry(record) ? record : undefined;
  },
};
