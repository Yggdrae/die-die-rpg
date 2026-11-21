import { check, Id } from '@rpg/contracts';
import { and, asc, eq, isNull, ne, sql } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import {
  NOTES_VISIBILITY,
  SESSION_LOG_RECORD_TYPE,
  SESSION_NOTE_RECORD_TYPE,
  SESSION_RECORD_TYPE,
  SESSION_VISIBILITY,
  type SessionLogEntryRecord,
  type SessionNoteRecord,
  type SessionRecord,
  type SessionStatus,
  sessionName,
} from '../../records.ts';
import { campaignSessions, sessionGmNotes, sessionLogEntries, sessionsSchema } from './schema.ts';

/**
 * Feature 18 persistence (`_db.md`). Reads carry no authorization: the service decides through feature 04. Every
 * write takes the executor, so the service writes and audits in one transaction.
 */

export type SessionsDatabase = PostgresJsDatabase<typeof sessionsSchema>;
export type SessionsTransaction = Parameters<Parameters<SessionsDatabase['transaction']>[0]>[0];

export function connectSessionsDatabase(connectionString: string, options: { max?: number } = {}) {
  const client = postgres(connectionString, {
    max: options.max ?? 5,
    prepare: false,
    onnotice: () => undefined,
  });
  return {
    db: drizzle(client, { schema: sessionsSchema, logger: false }),
    close: async () => client.end(),
  };
}

const iso = (value: Date) => value.toISOString();

function envelope(row: {
  readonly id: string;
  readonly campaignId: string;
  readonly version: number;
  readonly createdAt: Date;
  readonly createdBy: string;
  readonly updatedAt: Date;
  readonly updatedBy: string;
  readonly deletedAt: Date | null;
}) {
  return {
    id: row.id,
    campaignId: row.campaignId,
    tags: [],
    metadata: {},
    version: row.version,
    createdAt: iso(row.createdAt),
    createdBy: row.createdBy,
    updatedAt: iso(row.updatedAt),
    updatedBy: row.updatedBy,
    ...(row.deletedAt === null ? {} : { deletedAt: iso(row.deletedAt) }),
  };
}

function sessionFrom(row: typeof campaignSessions.$inferSelect): SessionRecord {
  return {
    ...envelope(row),
    type: SESSION_RECORD_TYPE,
    name: sessionName(row.number),
    visibility: SESSION_VISIBILITY,
    number: row.number,
    status: row.status as SessionStatus,
    startedAt: iso(row.startedAt),
    ...(row.endedAt === null ? {} : { endedAt: iso(row.endedAt) }),
    ...(row.currentSceneId === null ? {} : { currentSceneId: row.currentSceneId }),
    participantUserIds: row.participantUserIds,
  };
}

function noteFrom(row: typeof sessionGmNotes.$inferSelect): SessionNoteRecord {
  return {
    ...envelope(row),
    type: SESSION_NOTE_RECORD_TYPE,
    name: 'GM notes',
    visibility: NOTES_VISIBILITY,
    body: row.body,
  };
}

function entryFrom(row: typeof sessionLogEntries.$inferSelect): SessionLogEntryRecord {
  return {
    ...envelope(row),
    type: SESSION_LOG_RECORD_TYPE,
    name: row.kind,
    visibility: { mode: row.visibilityMode as 'gm_only' | 'everyone' },
    sessionId: row.sessionId,
    kind: row.kind as SessionLogEntryRecord['kind'],
    text: row.text,
    ...(row.subjectId === null ? {} : { subjectId: row.subjectId }),
  };
}

interface Read {
  readonly executor?: SessionsTransaction;
  readonly lock?: boolean;
}

export class PostgresSessionRepository {
  constructor(private readonly db: SessionsDatabase) {}

  transaction<T>(work: (transaction: SessionsTransaction) => Promise<T>): Promise<T> {
    return this.db.transaction(work);
  }

  /** Serializes numbering and the open-session check of one campaign (D-04). */
  async lockCampaign(executor: SessionsTransaction, campaignId: string): Promise<void> {
    await executor.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`sessions:${campaignId}`}, 0))`,
    );
  }

  async getSession(campaignId: string, id: string, options: Read = {}) {
    if (!check(Id, id) || !check(Id, campaignId)) return undefined;
    const query = (options.executor ?? this.db)
      .select()
      .from(campaignSessions)
      .where(and(eq(campaignSessions.campaignId, campaignId), eq(campaignSessions.id, id)));
    const [row] = options.lock === true ? await query.for('update') : await query;
    return row === undefined ? undefined : sessionFrom(row);
  }

  async listSessions(campaignId: string): Promise<SessionRecord[]> {
    if (!check(Id, campaignId)) return [];
    const rows = await this.db
      .select()
      .from(campaignSessions)
      .where(and(eq(campaignSessions.campaignId, campaignId), isNull(campaignSessions.deletedAt)))
      .orderBy(asc(campaignSessions.number));
    return rows.map(sessionFrom);
  }

  async hasOpenSession(executor: SessionsTransaction, campaignId: string): Promise<boolean> {
    const [row] = await executor
      .select({ id: campaignSessions.id })
      .from(campaignSessions)
      .where(
        and(
          eq(campaignSessions.campaignId, campaignId),
          ne(campaignSessions.status, 'ended'),
          isNull(campaignSessions.deletedAt),
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  async nextNumber(executor: SessionsTransaction, campaignId: string): Promise<number> {
    const [row] = await executor
      .select({ highest: sql<number>`coalesce(max(${campaignSessions.number}), 0)::int` })
      .from(campaignSessions)
      .where(eq(campaignSessions.campaignId, campaignId));
    return (row?.highest ?? 0) + 1;
  }

  /** `undefined` when the id exists already (a client-generated id is never overwritten). */
  async insertSession(
    executor: SessionsTransaction,
    input: {
      readonly id: string;
      readonly campaignId: string;
      readonly number: number;
      readonly status: SessionStatus;
      readonly startedAt: string;
      readonly endedAt?: string;
      readonly currentSceneId?: string;
      readonly participantUserIds: readonly string[];
      readonly actorUserId: string;
    },
  ): Promise<SessionRecord | undefined> {
    const [row] = await executor
      .insert(campaignSessions)
      .values({
        id: input.id,
        campaignId: input.campaignId,
        number: input.number,
        status: input.status,
        startedAt: new Date(input.startedAt),
        endedAt: input.endedAt === undefined ? null : new Date(input.endedAt),
        currentSceneId: input.currentSceneId ?? null,
        participantUserIds: [...input.participantUserIds],
        createdBy: input.actorUserId,
        updatedBy: input.actorUserId,
      })
      .onConflictDoNothing({ target: campaignSessions.id })
      .returning();
    return row === undefined ? undefined : sessionFrom(row);
  }

  /** Compare-and-set on the version; `undefined` when it moved. */
  async updateSession(
    executor: SessionsTransaction,
    input: {
      readonly campaignId: string;
      readonly id: string;
      readonly expectedVersion: number;
      readonly status: SessionStatus;
      readonly endedAt?: string;
      readonly currentSceneId?: string;
      readonly participantUserIds: readonly string[];
      readonly actorUserId: string;
    },
  ): Promise<SessionRecord | undefined> {
    const [row] = await executor
      .update(campaignSessions)
      .set({
        status: input.status,
        endedAt: input.endedAt === undefined ? null : new Date(input.endedAt),
        currentSceneId: input.currentSceneId ?? null,
        participantUserIds: [...input.participantUserIds],
        version: sql`${campaignSessions.version} + 1`,
        updatedAt: new Date(),
        updatedBy: input.actorUserId,
      })
      .where(
        and(
          eq(campaignSessions.campaignId, input.campaignId),
          eq(campaignSessions.id, input.id),
          eq(campaignSessions.version, input.expectedVersion),
        ),
      )
      .returning();
    return row === undefined ? undefined : sessionFrom(row);
  }

  async getNote(campaignId: string, id: string, options: Read = {}) {
    if (!check(Id, id) || !check(Id, campaignId)) return undefined;
    const query = (options.executor ?? this.db)
      .select()
      .from(sessionGmNotes)
      .where(and(eq(sessionGmNotes.campaignId, campaignId), eq(sessionGmNotes.id, id)));
    const [row] = options.lock === true ? await query.for('update') : await query;
    return row === undefined ? undefined : noteFrom(row);
  }

  async listNotes(campaignId: string): Promise<SessionNoteRecord[]> {
    if (!check(Id, campaignId)) return [];
    const rows = await this.db
      .select()
      .from(sessionGmNotes)
      .where(and(eq(sessionGmNotes.campaignId, campaignId), isNull(sessionGmNotes.deletedAt)))
      .orderBy(asc(sessionGmNotes.id));
    return rows.map(noteFrom);
  }

  async insertNote(
    executor: SessionsTransaction,
    input: {
      readonly id: string;
      readonly campaignId: string;
      readonly body: string;
      readonly actorUserId: string;
    },
  ): Promise<SessionNoteRecord | undefined> {
    const [row] = await executor
      .insert(sessionGmNotes)
      .values({
        id: input.id,
        campaignId: input.campaignId,
        body: input.body,
        createdBy: input.actorUserId,
        updatedBy: input.actorUserId,
      })
      .onConflictDoNothing({ target: sessionGmNotes.id })
      .returning();
    return row === undefined ? undefined : noteFrom(row);
  }

  async updateNote(
    executor: SessionsTransaction,
    input: {
      readonly campaignId: string;
      readonly id: string;
      readonly expectedVersion: number;
      readonly body: string;
      readonly actorUserId: string;
    },
  ): Promise<SessionNoteRecord | undefined> {
    const [row] = await executor
      .update(sessionGmNotes)
      .set({
        body: input.body,
        version: sql`${sessionGmNotes.version} + 1`,
        updatedAt: new Date(),
        updatedBy: input.actorUserId,
      })
      .where(
        and(
          eq(sessionGmNotes.campaignId, input.campaignId),
          eq(sessionGmNotes.id, input.id),
          eq(sessionGmNotes.version, input.expectedVersion),
        ),
      )
      .returning();
    return row === undefined ? undefined : noteFrom(row);
  }

  async getEntry(campaignId: string, id: string, options: Read = {}) {
    if (!check(Id, id) || !check(Id, campaignId)) return undefined;
    const [row] = await (options.executor ?? this.db)
      .select()
      .from(sessionLogEntries)
      .where(and(eq(sessionLogEntries.campaignId, campaignId), eq(sessionLogEntries.id, id)));
    return row === undefined ? undefined : entryFrom(row);
  }

  async listEntries(campaignId: string): Promise<SessionLogEntryRecord[]> {
    if (!check(Id, campaignId)) return [];
    const rows = await this.db
      .select()
      .from(sessionLogEntries)
      .where(and(eq(sessionLogEntries.campaignId, campaignId), isNull(sessionLogEntries.deletedAt)))
      .orderBy(asc(sessionLogEntries.createdAt), asc(sessionLogEntries.id));
    return rows.map(entryFrom);
  }

  async insertEntry(
    executor: SessionsTransaction,
    input: {
      readonly id: string;
      readonly campaignId: string;
      readonly sessionId: string;
      readonly kind: SessionLogEntryRecord['kind'];
      readonly text: string;
      readonly subjectId?: string;
      readonly visibilityMode: 'gm_only' | 'everyone';
      readonly createdAt: string;
      readonly actorUserId: string;
    },
  ): Promise<SessionLogEntryRecord | undefined> {
    const at = new Date(input.createdAt);
    const [row] = await executor
      .insert(sessionLogEntries)
      .values({
        id: input.id,
        campaignId: input.campaignId,
        sessionId: input.sessionId,
        kind: input.kind,
        text: input.text,
        subjectId: input.subjectId ?? null,
        visibilityMode: input.visibilityMode,
        createdAt: at,
        updatedAt: at,
        createdBy: input.actorUserId,
        updatedBy: input.actorUserId,
      })
      .onConflictDoNothing({ target: sessionLogEntries.id })
      .returning();
    return row === undefined ? undefined : entryFrom(row);
  }
}
