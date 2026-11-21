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
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Feature 18 `_db.md`: sessions, their GM notes (`gm_only`, a row of their own), and immutable log entries. No
 * foreign key to other features' tables.
 */

const instant = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

const standard = {
  visibilityTargets: jsonb('visibility_targets').$type<string[]>().notNull().default([]),
  version: bigint('version', { mode: 'number' }).notNull().default(1),
  createdAt: instant('created_at').notNull().defaultNow(),
  updatedAt: instant('updated_at').notNull().defaultNow(),
  createdBy: uuid('created_by').notNull(),
  updatedBy: uuid('updated_by').notNull(),
  deletedAt: instant('deleted_at'),
};

export const campaignSessions = pgTable(
  'campaign_sessions',
  {
    id: uuid('id').primaryKey(),
    campaignId: uuid('campaign_id').notNull(),
    number: integer('number').notNull(),
    status: text('status').notNull(),
    startedAt: instant('started_at').notNull(),
    endedAt: instant('ended_at'),
    currentSceneId: uuid('current_scene_id'),
    participantUserIds: jsonb('participant_user_ids').$type<string[]>().notNull().default([]),
    visibilityMode: text('visibility_mode').notNull().default('everyone'),
    ...standard,
  },
  (table) => [
    uniqueIndex('campaign_sessions_number_idx').on(table.campaignId, table.number),
    uniqueIndex('campaign_sessions_open_idx')
      .on(table.campaignId)
      .where(sql`${table.status} <> 'ended' AND ${table.deletedAt} IS NULL`),
    check('campaign_sessions_number_check', sql`${table.number} >= 1`),
    check('campaign_sessions_status_check', sql`${table.status} IN ('active', 'paused', 'ended')`),
    check(
      'campaign_sessions_ended_check',
      sql`(${table.status} = 'ended') = (${table.endedAt} IS NOT NULL)
        AND (${table.endedAt} IS NULL OR ${table.endedAt} >= ${table.startedAt})`,
    ),
    check(
      'campaign_sessions_participants_check',
      sql`jsonb_typeof(${table.participantUserIds}) = 'array'
        AND jsonb_array_length(${table.participantUserIds}) <= 64`,
    ),
    check(
      'campaign_sessions_visibility_check',
      sql`${table.visibilityMode} = 'everyone' AND ${table.visibilityTargets} = '[]'::jsonb`,
    ),
    check('campaign_sessions_version_check', sql`${table.version} >= 1`),
  ],
);

export const sessionGmNotes = pgTable(
  'session_gm_notes',
  {
    id: uuid('id').primaryKey(),
    campaignId: uuid('campaign_id').notNull(),
    body: text('body').notNull(),
    visibilityMode: text('visibility_mode').notNull().default('gm_only'),
    ...standard,
  },
  (table) => [
    index('session_gm_notes_campaign_idx').on(table.campaignId),
    check('session_gm_notes_body_check', sql`char_length(${table.body}) <= 20000`),
    check(
      'session_gm_notes_visibility_check',
      sql`${table.visibilityMode} = 'gm_only' AND ${table.visibilityTargets} = '[]'::jsonb`,
    ),
    check('session_gm_notes_version_check', sql`${table.version} >= 1`),
  ],
);

export const sessionLogEntries = pgTable(
  'session_log_entries',
  {
    id: uuid('id').primaryKey(),
    campaignId: uuid('campaign_id').notNull(),
    sessionId: uuid('session_id').notNull(),
    kind: text('kind').notNull(),
    text: text('text').notNull(),
    subjectId: uuid('subject_id'),
    visibilityMode: text('visibility_mode').notNull(),
    ...standard,
  },
  (table) => [
    index('session_log_entries_session_idx').on(table.campaignId, table.sessionId),
    check(
      'session_log_entries_kind_check',
      sql`(${table.kind} = 'note' AND char_length(${table.text}) BETWEEN 1 AND 500
          AND ${table.subjectId} IS NULL)
        OR (${table.kind} = 'scene' AND ${table.text} = '' AND ${table.subjectId} IS NOT NULL
          AND ${table.visibilityMode} = 'everyone')
        OR (${table.kind} = 'status' AND ${table.text} IN ('started', 'paused', 'resumed', 'ended')
          AND ${table.subjectId} IS NULL AND ${table.visibilityMode} = 'everyone')
        OR (${table.kind} = 'reveal' AND ${table.text} = '' AND ${table.subjectId} IS NOT NULL
          AND ${table.visibilityMode} = 'gm_only')`,
    ),
    check(
      'session_log_entries_visibility_check',
      sql`${table.visibilityMode} IN ('gm_only', 'everyone')
        AND ${table.visibilityTargets} = '[]'::jsonb`,
    ),
    check('session_log_entries_version_check', sql`${table.version} = 1`),
  ],
);

export const sessionsSchema = { campaignSessions, sessionGmNotes, sessionLogEntries };
