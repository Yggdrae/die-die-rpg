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
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Feature 09 `_db.md`: recorded rolls, the feature's own store (D-08). Immutable (D-09): `version` is
 * always 1 and there is no `deleted_at`. Visibility uses the feature 04 standard columns; the targets
 * CHECK calls `dice_visibility_targets_valid(jsonb)`, created by the same migration. No foreign key to
 * `campaigns` or to sessions (cross-feature tables).
 */

const instant = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const diceRolls = pgTable(
  'dice_rolls',
  {
    id: uuid('id').primaryKey(),
    campaignId: uuid('campaign_id').notNull(),
    actorUserId: uuid('actor_user_id').notNull(),
    actorRef: text('actor_ref'),
    targetRef: text('target_ref'),
    action: text('action'),
    sessionId: uuid('session_id'),
    expression: text('expression').notNull(),
    inputs: jsonb('inputs').$type<Record<string, number>>().notNull().default({}),
    result: jsonb('result').$type<unknown>().notNull(),
    naturalResult: integer('natural_result').notNull(),
    modifiedResult: integer('modified_result').notNull(),
    rollVisibility: text('roll_visibility').notNull(),
    visibilityMode: text('visibility_mode').notNull(),
    visibilityTargets: jsonb('visibility_targets').$type<string[]>().notNull().default([]),
    version: bigint('version', { mode: 'number' }).notNull().default(1),
    rolledAt: instant('rolled_at').notNull(),
    createdAt: instant('created_at').notNull().defaultNow(),
  },
  (table) => [
    index('dice_rolls_campaign_rolled_idx').on(table.campaignId, table.rolledAt.desc()),
    index('dice_rolls_session_idx')
      .on(table.campaignId, table.sessionId, table.rolledAt)
      .where(sql`${table.sessionId} IS NOT NULL`),
    check('dice_rolls_version_check', sql`${table.version} = 1`),
    check('dice_rolls_expression_check', sql`char_length(${table.expression}) BETWEEN 1 AND 200`),
    check('dice_rolls_inputs_check', sql`jsonb_typeof(${table.inputs}) = 'object'`),
    check('dice_rolls_result_check', sql`jsonb_typeof(${table.result}) = 'object'`),
    check(
      'dice_rolls_references_check',
      sql`(${table.actorRef} IS NULL OR char_length(${table.actorRef}) BETWEEN 1 AND 128)
        AND (${table.targetRef} IS NULL OR char_length(${table.targetRef}) BETWEEN 1 AND 128)
        AND (${table.action} IS NULL OR char_length(${table.action}) BETWEEN 1 AND 128)`,
    ),
    check(
      'dice_rolls_visibility_mode_check',
      sql`${table.visibilityMode} IN ('gm_only', 'everyone', 'party', 'players')`,
    ),
    check(
      'dice_rolls_visibility_targets_check',
      sql`dice_visibility_targets_valid(${table.visibilityTargets})`,
    ),
    // D-11: the label and the columns the stream filters on can never disagree.
    check(
      'dice_rolls_visibility_check',
      sql`CASE ${table.rollVisibility}
        WHEN 'public' THEN ${table.visibilityMode} = 'everyone'
          AND ${table.visibilityTargets} = '[]'::jsonb
        WHEN 'gm_only' THEN ${table.visibilityMode} = 'gm_only'
          AND ${table.visibilityTargets} = '[]'::jsonb
        WHEN 'blind' THEN ${table.visibilityMode} = 'gm_only'
          AND ${table.visibilityTargets} = '[]'::jsonb
        WHEN 'player_only' THEN ${table.visibilityMode} = 'players'
          AND ${table.visibilityTargets} = jsonb_build_array(${table.actorUserId}::text)
        WHEN 'whisper' THEN ${table.visibilityMode} = 'players'
          AND ${table.visibilityTargets} @> jsonb_build_array(${table.actorUserId}::text)
          AND jsonb_array_length(${table.visibilityTargets}) >= 2
        ELSE false END`,
    ),
  ],
);

export const diceSchema = { diceRolls };
