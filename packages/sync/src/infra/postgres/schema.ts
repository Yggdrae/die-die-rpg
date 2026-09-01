import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
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
  },
  (table) => [
    primaryKey({ columns: [table.campaignId, table.replicaId, table.tableName] }),
    check('sync_replica_watermarks_sequence_check', sql`${table.acknowledgedSequence} >= 0`),
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
  syncLongTextHolds,
  syncMutationReceipts,
  syncReplicaWatermarks,
};
