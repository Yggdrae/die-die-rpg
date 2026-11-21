import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Feature 06 `_db.md`. The campaign and GM-private stores share a column shape but no parent,
 * partition, view, or allocator: a broad query over one can never reach the other. Each store
 * owns its own campaign-scoped sequence allocator, so a gap in campaign order never discloses
 * how many private events exist. Append-only privileges and guard triggers live in the
 * hand-written tail of the migration that creates these tables.
 */

const instant = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

const ROLE_CHECK = sql.raw(`('owner', 'gm', 'assistant_gm', 'player', 'observer')`);

function campaignEventColumns() {
  return {
    id: uuid('id').primaryKey(),
    campaignId: uuid('campaign_id').notNull(),
    sessionId: uuid('session_id'),
    campaignSequence: bigint('campaign_sequence', { mode: 'number' }).notNull(),
    actorUserId: uuid('actor_user_id').notNull(),
    actorRole: text('actor_role').notNull(),
    action: text('action').notNull(),
    targetType: text('target_type').notNull(),
    targetId: uuid('target_id').notNull(),
    targetVisibility: jsonb('target_visibility').notNull(),
    beforeValue: jsonb('before_value'),
    afterValue: jsonb('after_value'),
    clientRecordedAt: instant('client_recorded_at').notNull(),
    acceptedAt: instant('accepted_at').notNull().defaultNow(),
    originMutationId: uuid('origin_mutation_id').notNull(),
    rendererVersion: integer('renderer_version').notNull(),
  };
}

export const auditCampaignEvents = pgTable(
  'audit_campaign_events',
  campaignEventColumns(),
  (table) => [
    unique('audit_campaign_events_sequence_unique').on(table.campaignId, table.campaignSequence),
    unique('audit_campaign_events_origin_unique').on(table.originMutationId),
    index('audit_campaign_events_session_idx').on(table.sessionId, table.campaignSequence.desc()),
    index('audit_campaign_events_actor_idx').on(
      table.campaignId,
      table.actorUserId,
      table.campaignSequence.desc(),
    ),
    index('audit_campaign_events_target_idx').on(
      table.campaignId,
      table.targetType,
      table.targetId,
      table.campaignSequence.desc(),
    ),
    check('audit_campaign_events_sequence_check', sql`${table.campaignSequence} >= 1`),
    check('audit_campaign_events_renderer_check', sql`${table.rendererVersion} >= 0`),
    check('audit_campaign_events_role_check', sql`${table.actorRole} IN ${ROLE_CHECK}`),
  ],
);

export const auditPrivateEvents = pgTable(
  'audit_private_events',
  campaignEventColumns(),
  (table) => [
    unique('audit_private_events_sequence_unique').on(table.campaignId, table.campaignSequence),
    unique('audit_private_events_origin_unique').on(table.originMutationId),
    index('audit_private_events_session_idx').on(table.sessionId, table.campaignSequence.desc()),
    index('audit_private_events_actor_idx').on(
      table.campaignId,
      table.actorUserId,
      table.campaignSequence.desc(),
    ),
    index('audit_private_events_target_idx').on(
      table.campaignId,
      table.targetType,
      table.targetId,
      table.campaignSequence.desc(),
    ),
    check('audit_private_events_sequence_check', sql`${table.campaignSequence} >= 1`),
    check('audit_private_events_renderer_check', sql`${table.rendererVersion} >= 0`),
    check('audit_private_events_role_check', sql`${table.actorRole} IN ${ROLE_CHECK}`),
  ],
);

export const auditCampaignSequences = pgTable(
  'audit_campaign_sequences',
  {
    campaignId: uuid('campaign_id').primaryKey(),
    lastSequence: bigint('last_sequence', { mode: 'number' }).notNull(),
  },
  (table) => [check('audit_campaign_sequences_check', sql`${table.lastSequence} >= 1`)],
);

export const auditPrivateSequences = pgTable(
  'audit_private_sequences',
  {
    campaignId: uuid('campaign_id').primaryKey(),
    lastSequence: bigint('last_sequence', { mode: 'number' }).notNull(),
  },
  (table) => [check('audit_private_sequences_check', sql`${table.lastSequence} >= 1`)],
);

/**
 * Account-scoped facts with no campaign (operator-issued recovery). Operator-only: no
 * campaign member, GM included, reads it, and no sync stream may reference it. Proposed in
 * `.speckit/features/06-audit-log/2026-10-24-account-audit-store.md` (pending review).
 */
export const auditAccountEvents = pgTable(
  'audit_account_events',
  {
    id: uuid('id').primaryKey(),
    accountSequence: bigint('account_sequence', { mode: 'number' })
      .notNull()
      .generatedAlwaysAsIdentity(),
    subjectUserId: uuid('subject_user_id').notNull(),
    actorKind: text('actor_kind').notNull(),
    actorUserId: uuid('actor_user_id'),
    actorReference: text('actor_reference'),
    action: text('action').notNull(),
    targetType: text('target_type').notNull(),
    targetId: uuid('target_id').notNull(),
    beforeValue: jsonb('before_value'),
    afterValue: jsonb('after_value'),
    clientRecordedAt: instant('client_recorded_at').notNull(),
    acceptedAt: instant('accepted_at').notNull().defaultNow(),
    originMutationId: uuid('origin_mutation_id').notNull(),
    rendererVersion: integer('renderer_version').notNull(),
  },
  (table) => [
    unique('audit_account_events_sequence_unique').on(table.accountSequence),
    unique('audit_account_events_origin_unique').on(table.originMutationId),
    index('audit_account_events_subject_idx').on(table.subjectUserId, table.accountSequence.desc()),
    check('audit_account_events_actor_check', sql`${table.actorKind} IN ('operator', 'user')`),
    check(
      'audit_account_events_actor_shape_check',
      sql`(${table.actorKind} = 'user') = (${table.actorUserId} IS NOT NULL)`,
    ),
    check('audit_account_events_renderer_check', sql`${table.rendererVersion} >= 0`),
  ],
);

/**
 * Restricted repair/dead-letter state for events that could not be appended. Holds the
 * validated envelope so an operator or the retry loop can replay it; never synchronized,
 * never logged. Mutable by design: it is a work queue, not history.
 */
export const auditRepairOutbox = pgTable(
  'audit_repair_outbox',
  {
    eventId: uuid('event_id').primaryKey(),
    store: text('store').notNull(),
    originMutationId: uuid('origin_mutation_id').notNull(),
    campaignId: uuid('campaign_id'),
    envelope: jsonb('envelope').notNull(),
    state: text('state').notNull(),
    failureCode: text('failure_code').notNull(),
    attemptCount: integer('attempt_count').notNull(),
    firstFailedAt: instant('first_failed_at').notNull().defaultNow(),
    lastFailedAt: instant('last_failed_at').notNull().defaultNow(),
    nextAttemptAt: instant('next_attempt_at').notNull(),
    resolvedAt: instant('resolved_at'),
  },
  (table) => [
    index('audit_repair_outbox_due_idx').on(table.state, table.nextAttemptAt),
    check(
      'audit_repair_outbox_store_check',
      sql`${table.store} IN ('campaign', 'private', 'account')`,
    ),
    check(
      'audit_repair_outbox_state_check',
      sql`${table.state} IN ('pending', 'dead', 'repaired')`,
    ),
    check('audit_repair_outbox_attempt_check', sql`${table.attemptCount} >= 1`),
  ],
);

export const auditSchema = {
  auditAccountEvents,
  auditCampaignEvents,
  auditCampaignSequences,
  auditPrivateEvents,
  auditPrivateSequences,
  auditRepairOutbox,
};
