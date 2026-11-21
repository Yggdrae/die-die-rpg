import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import type { MutationOutcome } from '../../model.ts';

const instant = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const syncMutationReceipts = pgTable('sync_mutation_receipts', {
  mutationId: uuid('mutation_id').primaryKey(),
  campaignId: uuid('campaign_id').notNull(),
  outcome: jsonb('outcome').$type<MutationOutcome>().notNull(),
  createdAt: instant('created_at').notNull().defaultNow(),
});

export const syncReplicaWatermarks = pgTable(
  'sync_replica_watermarks',
  {
    campaignId: uuid('campaign_id').notNull(),
    userId: uuid('user_id').notNull(),
    replicaId: uuid('replica_id').notNull(),
    tableName: text('table_name').notNull(),
    acknowledgedSequence: bigint('acknowledged_sequence', { mode: 'number' }).notNull().default(0),
    acknowledgedAt: instant('acknowledged_at').notNull().defaultNow(),
    revokedAt: instant('revoked_at'),
    /** Record IDs this replica still had unfinished local work for at acknowledgement time. */
    pendingRecordIds: jsonb('pending_record_ids').$type<string[]>().notNull().default([]),
  },
  (table) => [
    primaryKey({ columns: [table.campaignId, table.replicaId, table.tableName] }),
    check('sync_replica_watermarks_sequence_check', sql`${table.acknowledgedSequence} >= 0`),
  ],
);

/**
 * One row per device replica subscribed to a campaign (registered at bootstrap after a current
 * access decision). `subscribed_at` decides purge eligibility; `revoked_at` marks the replica for
 * destruction (access revoked or local cleanup acknowledged).
 */
export const syncReplicaSubscriptions = pgTable(
  'sync_replica_subscriptions',
  {
    campaignId: uuid('campaign_id').notNull(),
    replicaId: uuid('replica_id').notNull(),
    userId: uuid('user_id').notNull(),
    subscribedAt: instant('subscribed_at').notNull().defaultNow(),
    revokedAt: instant('revoked_at'),
  },
  (table) => [
    primaryKey({ columns: [table.campaignId, table.replicaId] }),
    index('sync_replica_subscriptions_user_idx').on(table.campaignId, table.userId),
  ],
);

/** Durable outbox of committed access-revocation facts and their delivery state. */
export const syncAccessRevocations = pgTable(
  'sync_access_revocations',
  {
    deliveryId: uuid('delivery_id').primaryKey().defaultRandom(),
    campaignId: uuid('campaign_id').notNull(),
    userId: uuid('user_id').notNull(),
    membershipVersion: bigint('membership_version', { mode: 'number' }).notNull(),
    reason: text('reason').notNull(),
    committedAt: instant('committed_at').notNull(),
    state: text('state').notNull().default('pending'),
    attemptCount: integer('attempt_count').notNull().default(0),
    nextAttemptAt: instant('next_attempt_at').notNull().defaultNow(),
    lastErrorCode: text('last_error_code'),
    lastAttemptAt: instant('last_attempt_at'),
    deliveredAt: instant('delivered_at'),
    createdAt: instant('created_at').notNull().defaultNow(),
  },
  (table) => [
    unique('sync_access_revocations_event_unique').on(
      table.campaignId,
      table.userId,
      table.membershipVersion,
      table.reason,
    ),
    index('sync_access_revocations_due_idx').on(table.state, table.nextAttemptAt),
    check(
      'sync_access_revocations_state_check',
      sql`${table.state} in ('pending', 'delivered', 'failed')`,
    ),
    check(
      'sync_access_revocations_reason_check',
      sql`${table.reason} in ('removed', 'role_changed', 'ownership_transferred', 'signed_out')`,
    ),
    check('sync_access_revocations_attempts_check', sql`${table.attemptCount} >= 0`),
  ],
);

export const syncLongTextHolds = pgTable(
  'sync_long_text_holds',
  {
    campaignId: uuid('campaign_id').notNull(),
    resourceClass: text('resource_class').notNull(),
    recordId: uuid('record_id').notNull(),
    fieldPath: text('field_path').notNull(),
    holderUserId: uuid('holder_user_id').notNull(),
    holderSessionId: uuid('holder_session_id').notNull(),
    acquiredAt: instant('acquired_at').notNull(),
    renewedAt: instant('renewed_at').notNull(),
    expiresAt: instant('expires_at').notNull(),
    version: bigint('version', { mode: 'number' }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.campaignId, table.resourceClass, table.recordId, table.fieldPath],
    }),
    check('sync_long_text_holds_version_check', sql`${table.version} >= 1`),
  ],
);

export const syncSchema = {
  syncAccessRevocations,
  syncLongTextHolds,
  syncMutationReceipts,
  syncReplicaSubscriptions,
  syncReplicaWatermarks,
};
