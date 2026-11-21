import {
  check,
  type ExportableModule,
  type ExportChunk,
  err,
  Id,
  type Id as IdValue,
  type ImportableModule,
  type ImportContext,
  type ImportPlanContribution,
  type ImportResult,
  type ImportTransaction,
  type ImportWarning,
  ok,
  type Result,
  Timestamp,
} from '@rpg/contracts';
import { type Static, Type } from '@sinclair/typebox';
import { SESSION_CLASS, SESSION_LOG_CLASS } from './policies.ts';
import {
  LOG_KINDS,
  MAX_LOG_TEXT,
  MAX_NOTES_LENGTH,
  MAX_PARTICIPANTS,
  SESSION_STATUSES,
  type SessionLogEntryRecord,
  type SessionNoteRecord,
  type SessionRecord,
} from './records.ts';

/**
 * Feature 18 export contributor (FR-014, D-15). Sessions, GM notes (export roles are GM roles), and log entries,
 * ordered for a stable chunk. Restored to the importer: participants are members, whom a new campaign does not
 * have, so they are dropped with a warning; a scene keeps its link when feature 16 restored it, else it is
 * cleared with a warning.
 */

export const SESSION_MODULE_ID = 'sessions';
export const SESSION_CHUNK_VERSION = '1';
export const SESSION_CHUNK_INVALID = 'session_chunk_invalid';
export const SESSION_ID_UNMAPPED = 'session_id_unmapped';
export const SESSION_IMPORT_UNAVAILABLE = 'session_import_unavailable';
export const SESSION_IMPORT_UNSUPPORTED = 'session_import_unsupported';
export const PARTICIPANT_DROPPED = 'session_participant_dropped';
export const SCENE_CLEARED = 'session_scene_cleared';

const SCENE_KIND = 'campaign_entity';

const SessionEntry = Type.Object(
  {
    id: Id,
    number: Type.Integer({ minimum: 1 }),
    status: Type.Union(SESSION_STATUSES.map((status) => Type.Literal(status))),
    startedAt: Timestamp,
    endedAt: Type.Optional(Timestamp),
    currentSceneId: Type.Optional(Id),
    participantUserIds: Type.Array(Id, { uniqueItems: true, maxItems: MAX_PARTICIPANTS }),
    notes: Type.Optional(Type.String({ maxLength: MAX_NOTES_LENGTH })),
  },
  { additionalProperties: false },
);

const LogEntry = Type.Object(
  {
    id: Id,
    sessionId: Id,
    kind: Type.Union(LOG_KINDS.map((kind) => Type.Literal(kind))),
    text: Type.String({ maxLength: MAX_LOG_TEXT }),
    subjectId: Type.Optional(Id),
    shown: Type.Boolean(),
    createdAt: Timestamp,
  },
  { additionalProperties: false },
);

export const SessionChunk = Type.Object(
  { campaignId: Id, sessions: Type.Array(SessionEntry), entries: Type.Array(LogEntry) },
  { additionalProperties: false },
);
export type SessionChunk = Static<typeof SessionChunk>;
export type SessionChunkSession = Static<typeof SessionEntry>;
export type SessionChunkEntry = Static<typeof LogEntry>;

export interface SessionExportSource {
  listSessions(campaignId: string): Promise<readonly SessionRecord[]>;
  listNotes(campaignId: string): Promise<readonly SessionNoteRecord[]>;
  listEntries(campaignId: string): Promise<readonly SessionLogEntryRecord[]>;
}

export interface SessionRestorePlan {
  readonly campaignId: IdValue;
  readonly actorUserId: IdValue;
  readonly sessions: readonly SessionChunkSession[];
  readonly entries: readonly SessionChunkEntry[];
}

export interface SessionImportDependencies {
  readonly writer: {
    restoreWithin(handle: unknown, plan: SessionRestorePlan): Promise<Result<void, string>>;
  };
  readonly unwrap: (transaction: ImportTransaction) => unknown;
}

function byId<T extends { readonly id: string }>(left: T, right: T): number {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function parseChunk(chunk: ExportChunk): Result<SessionChunk, string> {
  if (
    chunk.moduleId !== SESSION_MODULE_ID ||
    chunk.chunkVersion !== SESSION_CHUNK_VERSION ||
    !check(SessionChunk, chunk.payload)
  ) {
    return err(SESSION_CHUNK_INVALID);
  }
  const payload = chunk.payload as SessionChunk;
  const ids = new Set(payload.sessions.map((session) => session.id));
  const valid =
    payload.sessions.every(
      (session) => (session.status === 'ended') === (session.endedAt !== undefined),
    ) && payload.entries.every((entry) => ids.has(entry.sessionId));
  return valid ? ok(payload) : err(SESSION_CHUNK_INVALID);
}

export function countSessionRecords(payload: unknown): number {
  const chunk = payload as SessionChunk;
  return chunk.sessions.length + chunk.entries.length;
}

export class SessionExporter implements ExportableModule, ImportableModule {
  readonly moduleId = SESSION_MODULE_ID;
  readonly importChunkVersions = [SESSION_CHUNK_VERSION] as const;

  constructor(
    private readonly source: SessionExportSource,
    private readonly importer?: SessionImportDependencies,
  ) {}

  async export(campaignId: IdValue): Promise<ExportChunk> {
    const [sessions, notes, entries] = await Promise.all([
      this.source.listSessions(campaignId),
      this.source.listNotes(campaignId),
      this.source.listEntries(campaignId),
    ]);
    const notesOf = new Map(notes.map((note) => [note.id, note.body]));
    const payload: SessionChunk = {
      campaignId,
      sessions: sessions
        .filter((session) => session.deletedAt === undefined)
        .map((session) => {
          const body = notesOf.get(session.id);
          return {
            id: session.id,
            number: session.number,
            status: session.status,
            startedAt: session.startedAt,
            ...(session.endedAt === undefined ? {} : { endedAt: session.endedAt }),
            ...(session.currentSceneId === undefined
              ? {}
              : { currentSceneId: session.currentSceneId }),
            participantUserIds: [...session.participantUserIds],
            ...(body === undefined ? {} : { notes: body }),
          };
        })
        .sort(byId),
      entries: entries
        .filter((entry) => entry.deletedAt === undefined)
        .map((entry) => ({
          id: entry.id,
          sessionId: entry.sessionId,
          kind: entry.kind,
          text: entry.text,
          ...(entry.subjectId === undefined ? {} : { subjectId: entry.subjectId }),
          shown: entry.visibility.mode === 'everyone',
          createdAt: entry.createdAt,
        }))
        .sort(byId),
    };
    return { moduleId: this.moduleId, chunkVersion: SESSION_CHUNK_VERSION, payload };
  }

  async validate(chunk: ExportChunk): Promise<Result<ImportPlanContribution, string>> {
    const parsed = parseChunk(chunk);
    if (!parsed.ok) return parsed;
    return ok({
      defines: [
        ...parsed.value.sessions.map((row) => ({ kind: SESSION_CLASS, sourceId: row.id })),
        ...parsed.value.entries.map((row) => ({ kind: SESSION_LOG_CLASS, sourceId: row.id })),
      ],
      warnings: [],
    });
  }

  async restore(chunk: ExportChunk, context: ImportContext): Promise<Result<ImportResult, string>> {
    if (this.importer === undefined) return err(SESSION_IMPORT_UNAVAILABLE);
    const parsed = parseChunk(chunk);
    if (!parsed.ok) return parsed;
    const warnings: ImportWarning[] = [];
    const sessions: SessionChunkSession[] = [];
    const sessionIds = new Map<string, string>();
    for (const row of parsed.value.sessions) {
      const id = context.mapId(SESSION_CLASS, row.id);
      if (id === undefined) return err(SESSION_ID_UNMAPPED);
      sessionIds.set(row.id, id);
      const participants = row.participantUserIds.flatMap((user) => {
        const mapped = context.mapId('member', user);
        return mapped === undefined ? [] : [mapped];
      });
      if (participants.length < row.participantUserIds.length) {
        warnings.push({
          code: PARTICIPANT_DROPPED,
          sourceId: row.id,
          count: row.participantUserIds.length - participants.length,
        });
      }
      const scene =
        row.currentSceneId === undefined
          ? undefined
          : context.mapId(SCENE_KIND, row.currentSceneId);
      if (row.currentSceneId !== undefined && scene === undefined) {
        warnings.push({ code: SCENE_CLEARED, sourceId: row.id });
      }
      const { currentSceneId: _scene, ...rest } = row;
      sessions.push({
        ...rest,
        id,
        participantUserIds: participants,
        ...(scene === undefined ? {} : { currentSceneId: scene }),
      });
    }
    const entries: SessionChunkEntry[] = [];
    for (const row of parsed.value.entries) {
      const id = context.mapId(SESSION_LOG_CLASS, row.id);
      const sessionId = sessionIds.get(row.sessionId);
      if (id === undefined || sessionId === undefined) return err(SESSION_ID_UNMAPPED);
      if (row.kind === 'scene') {
        const subject =
          row.subjectId === undefined ? undefined : context.mapId(SCENE_KIND, row.subjectId);
        if (subject === undefined) {
          warnings.push({ code: SCENE_CLEARED, sourceId: row.id });
          continue;
        }
        entries.push({ ...row, id, sessionId, subjectId: subject });
        continue;
      }
      entries.push({ ...row, id, sessionId });
    }
    const written = await this.importer.writer.restoreWithin(
      this.importer.unwrap(context.transaction),
      { campaignId: context.campaignId, actorUserId: context.importerUserId, sessions, entries },
    );
    if (!written.ok) return written;
    return ok({ restoredCount: sessions.length + entries.length, warnings });
  }

  async import(_campaignId: IdValue, chunk: ExportChunk): Promise<Result<void, string>> {
    const parsed = parseChunk(chunk);
    return parsed.ok ? err(SESSION_IMPORT_UNSUPPORTED) : parsed;
  }
}
