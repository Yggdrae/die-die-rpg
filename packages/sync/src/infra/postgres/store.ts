import { and, eq, sql } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import type { MutationReceiptStore } from '../../authority.ts';
import type { LongTextHoldRepository } from '../../holds.ts';
import type { LongTextFieldRef, LongTextHold, MutationOutcome } from '../../model.ts';
import {
  syncLongTextHolds,
  syncMutationReceipts,
  syncReplicaWatermarks,
  syncSchema,
} from './schema.ts';

export type SyncDatabase = PostgresJsDatabase<typeof syncSchema>;

export interface SyncDatabaseConnection {
  readonly db: SyncDatabase;
  close(): Promise<void>;
}

export function connectSyncDatabase(connectionString: string): SyncDatabaseConnection {
  const client = postgres(connectionString, {
    max: 6,
    prepare: false,
    onnotice: () => undefined,
  });
  return {
    db: drizzle(client, { schema: syncSchema, logger: false }),
    close: async () => client.end(),
  };
}

export class PostgresMutationReceiptStore implements MutationReceiptStore {
  constructor(private readonly db: SyncDatabase) {}

  async get(mutationId: string): Promise<MutationOutcome | undefined> {
    return (
      await this.db
        .select({ outcome: syncMutationReceipts.outcome })
        .from(syncMutationReceipts)
        .where(eq(syncMutationReceipts.mutationId, mutationId))
        .limit(1)
    )[0]?.outcome;
  }

  async save(campaignId: string, outcome: MutationOutcome): Promise<void> {
    await this.db
      .insert(syncMutationReceipts)
      .values({ mutationId: outcome.mutationId, campaignId, outcome })
      .onConflictDoNothing({ target: syncMutationReceipts.mutationId });
  }

  async runExclusive<T>(mutationId: string, task: () => Promise<T>): Promise<T> {
    return this.db.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${mutationId}, 0))`,
      );
      return task();
    });
  }
}

export class PostgresLongTextHoldRepository implements LongTextHoldRepository {
  constructor(private readonly db: SyncDatabase) {}

  async databaseNow(): Promise<Date> {
    const rows = await this.db.execute<{ databaseNow: Date }>(
      sql`select transaction_timestamp() as "databaseNow"`,
    );
    const databaseNow = rows[0]?.databaseNow;
    if (databaseNow === undefined) throw new Error('sync database time unavailable');
    return databaseNow;
  }

  async get(field: LongTextFieldRef): Promise<LongTextHold | undefined> {
    const row = (
      await this.db.select().from(syncLongTextHolds).where(holdWhere(field)).limit(1)
    )[0];
    return row === undefined
      ? undefined
      : {
          campaignId: row.campaignId,
          resourceClass: row.resourceClass,
          recordId: row.recordId,
          fieldPath: row.fieldPath,
          holderUserId: row.holderUserId,
          holderSessionId: row.holderSessionId,
          acquiredAt: row.acquiredAt.toISOString(),
          renewedAt: row.renewedAt.toISOString(),
          expiresAt: row.expiresAt.toISOString(),
          version: row.version,
        };
  }

  async compareAndSet(
    field: LongTextFieldRef,
    expectedVersion: number | null,
    hold: LongTextHold | undefined,
  ): Promise<boolean> {
    if (expectedVersion === null) {
      if (hold === undefined) return true;
      const inserted = await this.db
        .insert(syncLongTextHolds)
        .values(toHoldRow(hold))
        .onConflictDoNothing()
        .returning({ version: syncLongTextHolds.version });
      return inserted.length === 1;
    }
    if (hold === undefined) {
      const deleted = await this.db
        .delete(syncLongTextHolds)
        .where(and(holdWhere(field), eq(syncLongTextHolds.version, expectedVersion)))
        .returning({ version: syncLongTextHolds.version });
      return deleted.length === 1;
    }
    const updated = await this.db
      .update(syncLongTextHolds)
      .set(toHoldRow(hold))
      .where(and(holdWhere(field), eq(syncLongTextHolds.version, expectedVersion)))
      .returning({ version: syncLongTextHolds.version });
    return updated.length === 1;
  }
}

export class PostgresWatermarkStore {
  constructor(private readonly db: SyncDatabase) {}

  async acknowledge(input: {
    readonly campaignId: string;
    readonly userId: string;
    readonly replicaId: string;
    readonly tableName: string;
    readonly sequence: number;
  }): Promise<void> {
    await this.db
      .insert(syncReplicaWatermarks)
      .values({
        campaignId: input.campaignId,
        userId: input.userId,
        replicaId: input.replicaId,
        tableName: input.tableName,
        acknowledgedSequence: input.sequence,
      })
      .onConflictDoUpdate({
        target: [
          syncReplicaWatermarks.campaignId,
          syncReplicaWatermarks.replicaId,
          syncReplicaWatermarks.tableName,
        ],
        set: {
          acknowledgedSequence: input.sequence,
          acknowledgedAt: sql`transaction_timestamp()`,
        },
        setWhere: sql`${syncReplicaWatermarks.acknowledgedSequence} <= ${input.sequence}`,
      });
  }

  async replicaDropped(input: {
    readonly campaignId: string;
    readonly userId: string;
    readonly replicaId: string;
  }): Promise<void> {
    await this.db
      .update(syncReplicaWatermarks)
      .set({ revokedAt: sql`transaction_timestamp()` })
      .where(
        and(
          eq(syncReplicaWatermarks.campaignId, input.campaignId),
          eq(syncReplicaWatermarks.userId, input.userId),
          eq(syncReplicaWatermarks.replicaId, input.replicaId),
        ),
      );
  }
}

function holdWhere(field: LongTextFieldRef) {
  return and(
    eq(syncLongTextHolds.campaignId, field.campaignId),
    eq(syncLongTextHolds.resourceClass, field.resourceClass),
    eq(syncLongTextHolds.recordId, field.recordId),
    eq(syncLongTextHolds.fieldPath, field.fieldPath),
  );
}

function toHoldRow(hold: LongTextHold) {
  return {
    campaignId: hold.campaignId,
    resourceClass: hold.resourceClass,
    recordId: hold.recordId,
    fieldPath: hold.fieldPath,
    holderUserId: hold.holderUserId,
    holderSessionId: hold.holderSessionId,
    acquiredAt: new Date(hold.acquiredAt),
    renewedAt: new Date(hold.renewedAt),
    expiresAt: new Date(hold.expiresAt),
    version: hold.version,
  };
}
