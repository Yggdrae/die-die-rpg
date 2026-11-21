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
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Feature 14 `_db.md`: one row per (campaign, user, section) with the bookmark and the last view, private to its owner
 * (fixed Visibility `players:[user_id]`). No foreign key to other features' tables.
 */

const instant = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const rulesSectionMarks = pgTable(
  'rules_section_marks',
  {
    id: uuid('id').primaryKey(),
    campaignId: uuid('campaign_id').notNull(),
    userId: uuid('user_id').notNull(),
    sectionId: text('section_id').notNull(),
    bookmarked: boolean('bookmarked').notNull().default(false),
    bookmarkChangedAt: instant('bookmark_changed_at'),
    viewedAt: instant('viewed_at'),
    visibilityMode: text('visibility_mode').notNull().default('players'),
    visibilityTargets: jsonb('visibility_targets').$type<string[]>().notNull(),
    version: bigint('version', { mode: 'number' }).notNull().default(1),
    createdAt: instant('created_at').notNull().defaultNow(),
    updatedAt: instant('updated_at').notNull().defaultNow(),
    createdBy: uuid('created_by').notNull(),
    updatedBy: uuid('updated_by').notNull(),
    deletedAt: instant('deleted_at'),
  },
  (table) => [
    uniqueIndex('rules_section_marks_owner_section_idx').on(
      table.campaignId,
      table.userId,
      table.sectionId,
    ),
    index('rules_section_marks_campaign_idx').on(table.campaignId),
    check(
      'rules_section_marks_section_check',
      sql`char_length(${table.sectionId}) BETWEEN 1 AND 64`,
    ),
    check(
      'rules_section_marks_bookmark_check',
      sql`(NOT ${table.bookmarked} OR ${table.bookmarkChangedAt} IS NOT NULL)
        AND (${table.bookmarkChangedAt} IS NOT NULL OR ${table.viewedAt} IS NOT NULL)`,
    ),
    check(
      'rules_section_marks_visibility_check',
      sql`${table.visibilityMode} = 'players'
        AND ${table.visibilityTargets} = jsonb_build_array(${table.userId}::text)`,
    ),
    check('rules_section_marks_version_check', sql`${table.version} >= 1`),
  ],
);

export const rulesSchema = { rulesSectionMarks };
