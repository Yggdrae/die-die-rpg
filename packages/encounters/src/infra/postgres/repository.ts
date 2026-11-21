import type { TargetState } from '@rpg/actions/engine';
import { check, Id } from '@rpg/contracts';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import {
  ENCOUNTER_NOTE_RECORD_TYPE,
  ENCOUNTER_NOTES_VISIBILITY,
  ENCOUNTER_RECORD_TYPE,
  ENCOUNTER_VISIBILITY,
  type EncounterNoteRecord,
  type EncounterRecord,
  type EncounterStatus,
  PARTICIPANT_RECORD_TYPE,
  type ParticipantRecord,
  type ParticipantStateRecord,
  type SourceKind,
} from '../../records.ts';
import {
  encounterGmNotes,
  encounterParticipantStates,
  encounterParticipants,
  encounters,
  encountersSchema,
} from './schema.ts';

/**
 * Feature 19 persistence (`_db.md`). Reads carry no authorization: the service decides through feature 04. Every
 * write takes the executor, so the service writes and audits in one transaction.
 */

export type EncountersDatabase = PostgresJsDatabase<typeof encountersSchema>;
export type EncountersTransaction = Parameters<Parameters<EncountersDatabase['transaction']>[0]>[0];

export function connectEncountersDatabase(
  connectionString: string,
  options: { max?: number } = {},
) {
  const client = postgres(connectionString, {
    max: options.max ?? 5,
    prepare: false,
    onnotice: () => undefined,
  });
  return {
    db: drizzle(client, { schema: encountersSchema, logger: false }),
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

function encounterFrom(row: typeof encounters.$inferSelect): EncounterRecord {
  return {
    ...envelope(row),
    type: ENCOUNTER_RECORD_TYPE,
    name: row.name,
    visibility: ENCOUNTER_VISIBILITY,
    ...(row.sessionId === null ? {} : { sessionId: row.sessionId }),
    status: row.status as EncounterStatus,
    startedAt: iso(row.startedAt),
    ...(row.endedAt === null ? {} : { endedAt: iso(row.endedAt) }),
    environment: row.environment,
    ...(row.locationId === null ? {} : { locationId: row.locationId }),
  };
}

function noteFrom(row: typeof encounterGmNotes.$inferSelect): EncounterNoteRecord {
  return {
    ...envelope(row),
    type: ENCOUNTER_NOTE_RECORD_TYPE,
    name: 'GM notes',
    visibility: ENCOUNTER_NOTES_VISIBILITY,
    body: row.body,
  };
}

function participantFrom(row: typeof encounterParticipants.$inferSelect): ParticipantRecord {
  return {
    ...envelope(row),
    type: PARTICIPANT_RECORD_TYPE,
    name: row.label,
    visibility: { mode: row.visibilityMode as 'gm_only' | 'everyone' },
    encounterId: row.encounterId,
    sourceKind: row.sourceKind as SourceKind,
    sourceId: row.sourceId,
    position: row.position,
    conditions: row.conditions,
  };
}

function stateFrom(row: typeof encounterParticipantStates.$inferSelect): ParticipantStateRecord {
  return {
    id: row.id,
    campaignId: row.campaignId,
    state: row.state as unknown as TargetState,
    version: row.version,
    updatedAt: iso(row.updatedAt),
    ...(row.deletedAt === null ? {} : { deletedAt: iso(row.deletedAt) }),
  };
}

interface Read {
  readonly executor?: EncountersTransaction;
  readonly lock?: boolean;
}

export class PostgresEncounterRepository {
  constructor(private readonly db: EncountersDatabase) {}

  transaction<T>(work: (transaction: EncountersTransaction) => Promise<T>): Promise<T> {
    return this.db.transaction(work);
  }

  async getEncounter(campaignId: string, id: string, options: Read = {}) {
    if (!check(Id, id) || !check(Id, campaignId)) return undefined;
    const query = (options.executor ?? this.db)
      .select()
      .from(encounters)
      .where(and(eq(encounters.campaignId, campaignId), eq(encounters.id, id)));
    const [row] = options.lock === true ? await query.for('update') : await query;
    return row === undefined ? undefined : encounterFrom(row);
  }

  async listEncounters(campaignId: string): Promise<EncounterRecord[]> {
    if (!check(Id, campaignId)) return [];
    const rows = await this.db
      .select()
      .from(encounters)
      .where(and(eq(encounters.campaignId, campaignId), isNull(encounters.deletedAt)))
      .orderBy(asc(encounters.startedAt), asc(encounters.id));
    return rows.map(encounterFrom);
  }

  /** `undefined` when the id exists already (a client-generated id is never overwritten). */
  async insertEncounter(
    executor: EncountersTransaction,
    input: {
      readonly id: string;
      readonly campaignId: string;
      readonly sessionId?: string;
      readonly name: string;
      readonly status: EncounterStatus;
      readonly startedAt: string;
      readonly endedAt?: string;
      readonly environment: string;
      readonly locationId?: string;
      readonly actorUserId: string;
    },
  ): Promise<EncounterRecord | undefined> {
    const [row] = await executor
      .insert(encounters)
      .values({
        id: input.id,
        campaignId: input.campaignId,
        sessionId: input.sessionId ?? null,
        name: input.name,
        status: input.status,
        startedAt: new Date(input.startedAt),
        endedAt: input.endedAt === undefined ? null : new Date(input.endedAt),
        environment: input.environment,
        locationId: input.locationId ?? null,
        createdBy: input.actorUserId,
        updatedBy: input.actorUserId,
      })
      .onConflictDoNothing({ target: encounters.id })
      .returning();
    return row === undefined ? undefined : encounterFrom(row);
  }

  /** Compare-and-set on the version; `undefined` when it moved. */
  async updateEncounter(
    executor: EncountersTransaction,
    input: {
      readonly campaignId: string;
      readonly id: string;
      readonly expectedVersion: number;
      readonly status: EncounterStatus;
      readonly endedAt?: string;
      readonly environment: string;
      readonly locationId?: string;
      readonly actorUserId: string;
    },
  ): Promise<EncounterRecord | undefined> {
    const [row] = await executor
      .update(encounters)
      .set({
        status: input.status,
        endedAt: input.endedAt === undefined ? null : new Date(input.endedAt),
        environment: input.environment,
        locationId: input.locationId ?? null,
        version: sql`${encounters.version} + 1`,
        updatedAt: new Date(),
        updatedBy: input.actorUserId,
      })
      .where(
        and(
          eq(encounters.campaignId, input.campaignId),
          eq(encounters.id, input.id),
          eq(encounters.version, input.expectedVersion),
        ),
      )
      .returning();
    return row === undefined ? undefined : encounterFrom(row);
  }

  async getNote(campaignId: string, id: string, options: Read = {}) {
    if (!check(Id, id) || !check(Id, campaignId)) return undefined;
    const query = (options.executor ?? this.db)
      .select()
      .from(encounterGmNotes)
      .where(and(eq(encounterGmNotes.campaignId, campaignId), eq(encounterGmNotes.id, id)));
    const [row] = options.lock === true ? await query.for('update') : await query;
    return row === undefined ? undefined : noteFrom(row);
  }

  async listNotes(campaignId: string): Promise<EncounterNoteRecord[]> {
    if (!check(Id, campaignId)) return [];
    const rows = await this.db
      .select()
      .from(encounterGmNotes)
      .where(and(eq(encounterGmNotes.campaignId, campaignId), isNull(encounterGmNotes.deletedAt)))
      .orderBy(asc(encounterGmNotes.id));
    return rows.map(noteFrom);
  }

  async insertNote(
    executor: EncountersTransaction,
    input: {
      readonly id: string;
      readonly campaignId: string;
      readonly body: string;
      readonly actorUserId: string;
    },
  ): Promise<EncounterNoteRecord | undefined> {
    const [row] = await executor
      .insert(encounterGmNotes)
      .values({
        id: input.id,
        campaignId: input.campaignId,
        body: input.body,
        createdBy: input.actorUserId,
        updatedBy: input.actorUserId,
      })
      .onConflictDoNothing({ target: encounterGmNotes.id })
      .returning();
    return row === undefined ? undefined : noteFrom(row);
  }

  async updateNote(
    executor: EncountersTransaction,
    input: {
      readonly campaignId: string;
      readonly id: string;
      readonly expectedVersion: number;
      readonly body: string;
      readonly actorUserId: string;
    },
  ): Promise<EncounterNoteRecord | undefined> {
    const [row] = await executor
      .update(encounterGmNotes)
      .set({
        body: input.body,
        version: sql`${encounterGmNotes.version} + 1`,
        updatedAt: new Date(),
        updatedBy: input.actorUserId,
      })
      .where(
        and(
          eq(encounterGmNotes.campaignId, input.campaignId),
          eq(encounterGmNotes.id, input.id),
          eq(encounterGmNotes.version, input.expectedVersion),
        ),
      )
      .returning();
    return row === undefined ? undefined : noteFrom(row);
  }

  async getParticipant(campaignId: string, id: string, options: Read = {}) {
    if (!check(Id, id) || !check(Id, campaignId)) return undefined;
    const query = (options.executor ?? this.db)
      .select()
      .from(encounterParticipants)
      .where(
        and(eq(encounterParticipants.campaignId, campaignId), eq(encounterParticipants.id, id)),
      );
    const [row] = options.lock === true ? await query.for('update') : await query;
    return row === undefined ? undefined : participantFrom(row);
  }

  async listParticipants(campaignId: string): Promise<ParticipantRecord[]> {
    if (!check(Id, campaignId)) return [];
    const rows = await this.db
      .select()
      .from(encounterParticipants)
      .where(
        and(
          eq(encounterParticipants.campaignId, campaignId),
          isNull(encounterParticipants.deletedAt),
        ),
      )
      .orderBy(asc(encounterParticipants.encounterId), asc(encounterParticipants.position));
    return rows.map(participantFrom);
  }

  /** The participant and, for an entity participant, its instance state, written together. */
  async insertParticipant(
    executor: EncountersTransaction,
    input: {
      readonly id: string;
      readonly campaignId: string;
      readonly encounterId: string;
      readonly label: string;
      readonly sourceKind: SourceKind;
      readonly sourceId: string;
      readonly position: number;
      readonly conditions: Readonly<Record<string, number>>;
      readonly visibilityMode: 'gm_only' | 'everyone';
      readonly state?: TargetState;
      readonly actorUserId: string;
    },
  ): Promise<ParticipantRecord | undefined> {
    const [row] = await executor
      .insert(encounterParticipants)
      .values({
        id: input.id,
        campaignId: input.campaignId,
        encounterId: input.encounterId,
        label: input.label,
        sourceKind: input.sourceKind,
        sourceId: input.sourceId,
        position: input.position,
        conditions: { ...input.conditions },
        visibilityMode: input.visibilityMode,
        createdBy: input.actorUserId,
        updatedBy: input.actorUserId,
      })
      .onConflictDoNothing({ target: encounterParticipants.id })
      .returning();
    if (row === undefined) return undefined;
    if (input.state !== undefined) {
      await executor.insert(encounterParticipantStates).values({
        id: input.id,
        campaignId: input.campaignId,
        state: input.state as unknown as Record<string, unknown>,
        createdBy: input.actorUserId,
        updatedBy: input.actorUserId,
      });
    }
    return participantFrom(row);
  }

  /** The participant's own fields (reveal, tombstone): compare-and-set on its version. */
  async updateParticipant(
    executor: EncountersTransaction,
    input: {
      readonly campaignId: string;
      readonly id: string;
      readonly expectedVersion: number;
      readonly visibilityMode?: 'everyone';
      readonly deleted?: true;
      readonly actorUserId: string;
    },
  ): Promise<ParticipantRecord | undefined> {
    const now = new Date();
    const [row] = await executor
      .update(encounterParticipants)
      .set({
        ...(input.visibilityMode === undefined ? {} : { visibilityMode: input.visibilityMode }),
        ...(input.deleted === true ? { deletedAt: now } : {}),
        version: sql`${encounterParticipants.version} + 1`,
        updatedAt: now,
        updatedBy: input.actorUserId,
      })
      .where(
        and(
          eq(encounterParticipants.campaignId, input.campaignId),
          eq(encounterParticipants.id, input.id),
          eq(encounterParticipants.version, input.expectedVersion),
          isNull(encounterParticipants.deletedAt),
        ),
      )
      .returning();
    if (row !== undefined && input.deleted === true) {
      await executor
        .update(encounterParticipantStates)
        .set({ deletedAt: now, version: sql`${encounterParticipantStates.version} + 1` })
        .where(
          and(
            eq(encounterParticipantStates.campaignId, input.campaignId),
            eq(encounterParticipantStates.id, input.id),
          ),
        );
    }
    return row === undefined ? undefined : participantFrom(row);
  }

  async getState(campaignId: string, id: string, options: Read = {}) {
    if (!check(Id, id) || !check(Id, campaignId)) return undefined;
    const query = (options.executor ?? this.db)
      .select()
      .from(encounterParticipantStates)
      .where(
        and(
          eq(encounterParticipantStates.campaignId, campaignId),
          eq(encounterParticipantStates.id, id),
        ),
      );
    const [row] = options.lock === true ? await query.for('update') : await query;
    return row === undefined ? undefined : stateFrom(row);
  }

  async listStates(campaignId: string): Promise<ParticipantStateRecord[]> {
    if (!check(Id, campaignId)) return [];
    const rows = await this.db
      .select()
      .from(encounterParticipantStates)
      .where(
        and(
          eq(encounterParticipantStates.campaignId, campaignId),
          isNull(encounterParticipantStates.deletedAt),
        ),
      )
      .orderBy(asc(encounterParticipantStates.id));
    return rows.map(stateFrom);
  }

  /**
   * D-13: feature 11's write. The public conditions go to the participant row without moving its version; the rest
   * to the state row, whose version moves.
   */
  async writeInstance(
    executor: EncountersTransaction,
    input: {
      readonly campaignId: string;
      readonly id: string;
      readonly conditions: Readonly<Record<string, number>>;
      readonly state: TargetState;
      readonly actorUserId: string;
    },
  ): Promise<void> {
    const now = new Date();
    await executor
      .update(encounterParticipants)
      .set({ conditions: { ...input.conditions }, updatedAt: now })
      .where(
        and(
          eq(encounterParticipants.campaignId, input.campaignId),
          eq(encounterParticipants.id, input.id),
        ),
      );
    await executor
      .update(encounterParticipantStates)
      .set({
        state: input.state as unknown as Record<string, unknown>,
        version: sql`${encounterParticipantStates.version} + 1`,
        updatedAt: now,
        updatedBy: input.actorUserId,
      })
      .where(
        and(
          eq(encounterParticipantStates.campaignId, input.campaignId),
          eq(encounterParticipantStates.id, input.id),
        ),
      );
  }
}
