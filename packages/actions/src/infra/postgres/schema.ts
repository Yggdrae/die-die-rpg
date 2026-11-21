import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Feature 11 `_db.md`: one row per accepted application, immutable, keyed by the idempotency id the device
 * generated. No foreign keys: the campaign, the session, the roll, and the target all belong to others.
 */

const instant = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const effectApplications = pgTable(
  'effect_applications',
  {
    id: uuid('id').primaryKey(),
    campaignId: uuid('campaign_id').notNull(),
    actorUserId: uuid('actor_user_id').notNull(),
    targetClass: text('target_class').notNull(),
    targetId: uuid('target_id').notNull(),
    action: text('action'),
    outcome: text('outcome'),
    rollId: uuid('roll_id'),
    sessionId: uuid('session_id'),
    operations: jsonb('operations').$type<unknown[]>().notNull(),
    changes: jsonb('changes').$type<unknown[]>().notNull().default([]),
    edited: boolean('edited').notNull().default(false),
    visibilityMode: text('visibility_mode').notNull(),
    visibilityTargets: jsonb('visibility_targets').$type<string[]>().notNull().default([]),
    version: bigint('version', { mode: 'number' }).notNull().default(1),
    appliedAt: instant('applied_at').notNull(),
    acceptedAt: instant('accepted_at').notNull().defaultNow(),
  },
  (table) => [
    index('effect_applications_target_idx').on(
      table.campaignId,
      table.targetClass,
      table.targetId,
      table.appliedAt,
    ),
    index('effect_applications_session_idx')
      .on(table.campaignId, table.sessionId, table.appliedAt)
      .where(sql`${table.sessionId} IS NOT NULL`),
    check('effect_applications_version_check', sql`${table.version} = 1`),
    check(
      'effect_applications_target_class_check',
      sql.raw(`target_class ~ '^[a-z][a-z0-9_]{0,63}$'`),
    ),
    check(
      'effect_applications_operations_check',
      sql`CASE WHEN jsonb_typeof(${table.operations}) = 'array'
        THEN jsonb_array_length(${table.operations}) BETWEEN 1 AND 64 ELSE false END`,
    ),
    check('effect_applications_changes_check', sql`jsonb_typeof(${table.changes}) = 'array'`),
    check(
      'effect_applications_references_check',
      sql`(${table.action} IS NULL OR char_length(${table.action}) BETWEEN 1 AND 128)
        AND (${table.outcome} IS NULL OR char_length(${table.outcome}) BETWEEN 1 AND 128)`,
    ),
    check(
      'effect_applications_visibility_mode_check',
      sql`${table.visibilityMode} IN ('gm_only', 'everyone', 'party', 'players')`,
    ),
    check(
      'effect_applications_visibility_targets_check',
      sql`CASE WHEN NOT effect_visibility_targets_valid(${table.visibilityTargets}) THEN false
        WHEN ${table.visibilityMode} IN ('gm_only', 'everyone')
          THEN ${table.visibilityTargets} = '[]'::jsonb
        ELSE jsonb_array_length(${table.visibilityTargets}) > 0 END`,
    ),
  ],
);

export const actionsSchema = { effectApplications };
