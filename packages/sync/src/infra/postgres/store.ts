import type {
  CampaignAccessRevoked,
  ReplicaWatermark,
  TombstonePurgeDecision,
  TombstonePurgeEvidence,
  TombstoneRef,
} from '@rpg/contracts';
import { and, asc, eq, isNull, lte, sql } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import type { MutationReceiptStore } from '../../authority.ts';
import type { LockedLongTextHold, LongTextHoldRepository } from '../../holds.ts';
import type { LongTextFieldRef, LongTextHold, MutationOutcome } from '../../model.ts';
import {
  type ConnectedAccessInvalidator,
  type RevocationDelivery,
  type RevocationDeliveryBacklog,
  type RevocationDeliveryOutbox,
  revokesReplicaAccess,
} from '../../revocation-delivery.ts';
import {
  decideTombstonePurge,
  type ReplicaScopeEligibility,
  type ReplicaSubscriptionRegistry,
  type TombstoneSubscriber,
} from '../../watermarks.ts';
import {
  syncAccessRevocations,
  syncLongTextHolds,
  syncMutationReceipts,
  syncReplicaSubscriptions,
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
    // Unprepared queries (`prepare: false`) return timestamptz as text, not Date.
    const rows = await this.db.execute<{ databaseNow: Date | string }>(
      sql`select transaction_timestamp() as "databaseNow"`,
    );
    const databaseNow = rows[0]?.databaseNow;
    if (databaseNow === undefined) throw new Error('sync database time unavailable');
    return new Date(databaseNow);
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

  /** `FOR SHARE`: concurrent writers of the same holder pass, any change of the hold waits. */
  async lockWithin(
    transaction: unknown,
    field: LongTextFieldRef,
  ): Promise<LockedLongTextHold | undefined> {
    const [row] = await (transaction as Pick<SyncDatabase, 'select'>)
      .select({
        holderSessionId: syncLongTextHolds.holderSessionId,
        version: syncLongTextHolds.version,
        live: sql<boolean>`${syncLongTextHolds.expiresAt} > clock_timestamp()`,
      })
      .from(syncLongTextHolds)
      .where(holdWhere(field))
      .limit(1)
      .for('share');
    return row;
  }
}

/** Server watermark acknowledgement on `sync_replica_watermarks`. */
export class PostgresWatermarkStore {
  constructor(private readonly db: SyncDatabase) {}

  /**
   * Monotonic per (campaign, replica, scope). A replica id already owned by another user is never
   * overwritten. `pendingRecordIds` is replaced on every accepted acknowledgement.
   */
  async acknowledge(input: {
    readonly campaignId: string;
    readonly userId: string;
    readonly replicaId: string;
    readonly tableName: string;
    readonly sequence: number;
    readonly pendingRecordIds?: readonly string[];
  }): Promise<void> {
    const pendingRecordIds = [...new Set(input.pendingRecordIds ?? [])].sort();
    await this.db
      .insert(syncReplicaWatermarks)
      .values({
        campaignId: input.campaignId,
        userId: input.userId,
        replicaId: input.replicaId,
        tableName: input.tableName,
        acknowledgedSequence: input.sequence,
        pendingRecordIds,
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
          pendingRecordIds,
        },
        setWhere: sql`${syncReplicaWatermarks.acknowledgedSequence} <= ${input.sequence}
          and ${syncReplicaWatermarks.userId} = ${input.userId}`,
      });
  }

  /** Local cleanup acknowledged after revocation: the replica is marked for destruction. */
  async replicaDropped(input: {
    readonly campaignId: string;
    readonly userId: string;
    readonly replicaId: string;
  }): Promise<void> {
    await this.db.transaction(async (transaction) => {
      await transaction
        .update(syncReplicaWatermarks)
        .set({ revokedAt: sql`transaction_timestamp()` })
        .where(
          and(
            eq(syncReplicaWatermarks.campaignId, input.campaignId),
            eq(syncReplicaWatermarks.userId, input.userId),
            eq(syncReplicaWatermarks.replicaId, input.replicaId),
          ),
        );
      await transaction
        .update(syncReplicaSubscriptions)
        .set({ revokedAt: sql`transaction_timestamp()` })
        .where(
          and(
            eq(syncReplicaSubscriptions.campaignId, input.campaignId),
            eq(syncReplicaSubscriptions.userId, input.userId),
            eq(syncReplicaSubscriptions.replicaId, input.replicaId),
            isNull(syncReplicaSubscriptions.revokedAt),
          ),
        );
    });
  }
}

/**
 * Replica subscription registry and the production connected-access invalidator: on access loss
 * every replica the user subscribed before the commit is marked for destruction. Bootstrap,
 * upload, and acknowledgement already deny on current membership; the provider stream joins on
 * active membership, so it stops serving the campaign once the membership row replicates.
 */
export class PostgresReplicaSubscriptionStore
  implements ReplicaSubscriptionRegistry, ConnectedAccessInvalidator
{
  constructor(private readonly db: SyncDatabase) {}

  async register(input: {
    readonly campaignId: string;
    readonly userId: string;
    readonly replicaId: string;
    readonly subscribedAt: Date;
  }): Promise<void> {
    await this.db
      .insert(syncReplicaSubscriptions)
      .values(input)
      .onConflictDoUpdate({
        target: [syncReplicaSubscriptions.campaignId, syncReplicaSubscriptions.replicaId],
        set: { revokedAt: null, subscribedAt: input.subscribedAt },
        setWhere: sql`${syncReplicaSubscriptions.userId} = ${input.userId}
          and ${syncReplicaSubscriptions.revokedAt} is not null`,
      });
  }

  async invalidate(event: CampaignAccessRevoked): Promise<void> {
    if (!revokesReplicaAccess(event)) return;
    await this.db
      .update(syncReplicaSubscriptions)
      .set({ revokedAt: sql`transaction_timestamp()` })
      .where(
        and(
          eq(syncReplicaSubscriptions.campaignId, event.campaignId),
          eq(syncReplicaSubscriptions.userId, event.userId),
          isNull(syncReplicaSubscriptions.revokedAt),
          // A retried old event never revokes a replica re-subscribed after a later rejoin.
          lte(syncReplicaSubscriptions.subscribedAt, new Date(event.committedAt)),
        ),
      );
  }
}

/** `sync_access_revocations` outbox for `DurableRevocationPublisher`. */
export class PostgresRevocationDeliveryOutbox implements RevocationDeliveryOutbox {
  constructor(private readonly db: SyncDatabase) {}

  async enqueue(event: CampaignAccessRevoked): Promise<RevocationDelivery> {
    await this.db
      .insert(syncAccessRevocations)
      .values({
        campaignId: event.campaignId,
        userId: event.userId,
        membershipVersion: event.membershipVersion,
        reason: event.reason,
        committedAt: new Date(event.committedAt),
      })
      .onConflictDoNothing({
        target: [
          syncAccessRevocations.campaignId,
          syncAccessRevocations.userId,
          syncAccessRevocations.membershipVersion,
          syncAccessRevocations.reason,
        ],
      });
    const row = (
      await this.db
        .select()
        .from(syncAccessRevocations)
        .where(
          and(
            eq(syncAccessRevocations.campaignId, event.campaignId),
            eq(syncAccessRevocations.userId, event.userId),
            eq(syncAccessRevocations.membershipVersion, event.membershipVersion),
            eq(syncAccessRevocations.reason, event.reason),
          ),
        )
        .limit(1)
    )[0];
    if (row === undefined) throw new Error('revocation_outbox_write_lost');
    return toDelivery(row);
  }

  async due(now: Date, limit: number): Promise<readonly RevocationDelivery[]> {
    const rows = await this.db
      .select()
      .from(syncAccessRevocations)
      .where(
        and(
          eq(syncAccessRevocations.state, 'pending'),
          lte(syncAccessRevocations.nextAttemptAt, now),
        ),
      )
      .orderBy(asc(syncAccessRevocations.nextAttemptAt), asc(syncAccessRevocations.createdAt))
      .limit(limit);
    return rows.map(toDelivery);
  }

  async delivered(deliveryId: string, at: Date): Promise<void> {
    await this.db
      .update(syncAccessRevocations)
      .set({ state: 'delivered', deliveredAt: at, lastAttemptAt: at })
      .where(eq(syncAccessRevocations.deliveryId, deliveryId));
  }

  async attemptFailed(
    deliveryId: string,
    input: { readonly code: string; readonly at: Date; readonly nextAttemptAt?: Date },
  ): Promise<void> {
    await this.db
      .update(syncAccessRevocations)
      .set({
        state: input.nextAttemptAt === undefined ? 'failed' : 'pending',
        attemptCount: sql`${syncAccessRevocations.attemptCount} + 1`,
        lastErrorCode: input.code,
        lastAttemptAt: input.at,
        ...(input.nextAttemptAt === undefined ? {} : { nextAttemptAt: input.nextAttemptAt }),
      })
      .where(eq(syncAccessRevocations.deliveryId, deliveryId));
  }

  async backlog(): Promise<RevocationDeliveryBacklog> {
    const [row] = await this.db
      .select({
        pending:
          sql<number>`count(*) filter (where ${syncAccessRevocations.state} = 'pending')`.mapWith(
            Number,
          ),
        failed:
          sql<number>`count(*) filter (where ${syncAccessRevocations.state} = 'failed')`.mapWith(
            Number,
          ),
        oldest: sql<Date | null>`min(${syncAccessRevocations.committedAt}) filter (where ${syncAccessRevocations.state} = 'pending')`,
      })
      .from(syncAccessRevocations);
    const oldest = row?.oldest == null ? undefined : new Date(row.oldest).toISOString();
    return {
      pending: row?.pending ?? 0,
      failed: row?.failed ?? 0,
      ...(oldest === undefined ? {} : { oldestPendingAt: oldest }),
    };
  }

  async get(deliveryId: string): Promise<RevocationDelivery | undefined> {
    const row = (
      await this.db
        .select()
        .from(syncAccessRevocations)
        .where(eq(syncAccessRevocations.deliveryId, deliveryId))
        .limit(1)
    )[0];
    return row === undefined ? undefined : toDelivery(row);
  }
}

/**
 * Production `TombstonePurgeEvidence` over `sync_replica_subscriptions` and
 * `sync_replica_watermarks` (`_db.md` watermark rule via `decideTombstonePurge`).
 *
 * Eligible subscriber: a replica subscribed at or before the deletion, plus any acknowledged
 * replica with no subscription row (pre-registry, conservatively eligible). It blocks until it
 * acknowledges `sequence` in the tombstone's scope or is revoked. Pending reference: any
 * unrevoked eligible replica whose latest acknowledgement still lists the record.
 *
 * With `eligibility`, replicas of users who cannot receive the scope at all (for example a
 * player for the GM-private audit store) are not subscribers of it. A failing eligibility answer
 * fails the decision; the caller then treats the tombstone as not safe.
 */
export class PostgresTombstonePurgeEvidence implements TombstonePurgeEvidence {
  constructor(
    private readonly db: SyncDatabase,
    private readonly watermarks: PostgresWatermarkStore = new PostgresWatermarkStore(db),
    private readonly eligibility?: ReplicaScopeEligibility,
  ) {}

  async acknowledge(
    watermark: ReplicaWatermark,
    pendingRecordIds: readonly string[] = [],
  ): Promise<void> {
    await this.watermarks.acknowledge({
      campaignId: watermark.campaignId,
      userId: watermark.userId,
      replicaId: watermark.replicaId,
      tableName: watermark.scope,
      sequence: watermark.sequence,
      pendingRecordIds,
    });
  }

  async decide(tombstone: TombstoneRef, now: Date): Promise<TombstonePurgeDecision> {
    const allSubscriptions = await this.db
      .select()
      .from(syncReplicaSubscriptions)
      .where(eq(syncReplicaSubscriptions.campaignId, tombstone.campaignId));
    const allMarks = await this.db
      .select()
      .from(syncReplicaWatermarks)
      .where(
        and(
          eq(syncReplicaWatermarks.campaignId, tombstone.campaignId),
          eq(syncReplicaWatermarks.tableName, tombstone.scope),
        ),
      );
    const eligible =
      this.eligibility === undefined
        ? undefined
        : await this.eligibility.eligibleUsers(tombstone.campaignId, tombstone.scope, [
            ...new Set([...allSubscriptions, ...allMarks].map((row) => row.userId)),
          ]);
    const receives = (row: { readonly userId: string }) =>
      eligible === undefined || eligible.has(row.userId);
    const subscriptions = allSubscriptions.filter(receives);
    const marks = allMarks.filter(receives);
    const byReplica = new Map(marks.map((mark) => [mark.replicaId, mark]));
    const deletedAt = Date.parse(tombstone.deletedAt);
    const subscribers: TombstoneSubscriber[] = subscriptions.map((subscription) => {
      const mark = byReplica.get(subscription.replicaId);
      const revokedAt = subscription.revokedAt ?? mark?.revokedAt ?? null;
      return {
        replicaId: subscription.replicaId,
        eligibleAtDeletion: subscription.subscribedAt.getTime() <= deletedAt,
        acknowledgedSequence: mark?.acknowledgedSequence ?? -1,
        ...(revokedAt === null ? {} : { revokedAt: revokedAt.toISOString() }),
      };
    });
    const registered = new Set(subscriptions.map((subscription) => subscription.replicaId));
    for (const mark of marks) {
      if (registered.has(mark.replicaId)) continue;
      subscribers.push({
        replicaId: mark.replicaId,
        eligibleAtDeletion: true,
        acknowledgedSequence: mark.acknowledgedSequence,
        ...(mark.revokedAt === null ? {} : { revokedAt: mark.revokedAt.toISOString() }),
      });
    }
    const active = new Set(
      subscribers
        .filter((subscriber) => subscriber.eligibleAtDeletion && subscriber.revokedAt === undefined)
        .map((subscriber) => subscriber.replicaId),
    );
    const referencedByPendingMutation = marks.some(
      (mark) => active.has(mark.replicaId) && mark.pendingRecordIds.includes(tombstone.recordId),
    );
    return decideTombstonePurge(
      {
        campaignId: tombstone.campaignId,
        tableName: tombstone.scope,
        recordId: tombstone.recordId,
        sequence: tombstone.sequence,
        deletedAt: tombstone.deletedAt,
        subscribers,
        referencedByPendingMutation,
      },
      now,
    );
  }
}

function toDelivery(row: typeof syncAccessRevocations.$inferSelect): RevocationDelivery {
  return {
    deliveryId: row.deliveryId,
    event: {
      campaignId: row.campaignId,
      userId: row.userId,
      membershipVersion: row.membershipVersion,
      reason: row.reason as CampaignAccessRevoked['reason'],
      committedAt: row.committedAt.toISOString(),
    },
    state: row.state as RevocationDelivery['state'],
    attemptCount: row.attemptCount,
    nextAttemptAt: row.nextAttemptAt.toISOString(),
    ...(row.lastErrorCode === null ? {} : { lastErrorCode: row.lastErrorCode }),
  };
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
