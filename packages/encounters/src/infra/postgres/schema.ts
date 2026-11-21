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
 * Feature 19 `_db.md`: encounters, their GM notes (`gm_only`), participants (per-row Visibility), and entity
 * participants' instance states (`gm_only`). No foreign key to other features' tables.
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

export const encounters = pgTable(
  'encounters',
  {
    id: uuid('id').primaryKey(),
    campaignId: uuid('campaign_id').notNull(),
    sessionId: uuid('session_id'),
    name: text('name').notNull(),
    status: text('status').notNull(),
    startedAt: instant('started_at').notNull(),
    endedAt: instant('ended_at'),
    environment: text('environment').notNull().default(''),
    locationId: uuid('location_id'),
    visibilityMode: text('visibility_mode').notNull().default('everyone'),
    ...standard,
  },
  (table) => [
    index('encounters_campaign_idx').on(table.campaignId),
    check('encounters_name_check', sql`char_length(${table.name}) BETWEEN 1 AND 120`),
    check('encounters_status_check', sql`${table.status} IN ('active', 'ended')`),
    check(
      'encounters_ended_check',
      sql`(${table.status} = 'ended') = (${table.endedAt} IS NOT NULL)
        AND (${table.endedAt} IS NULL OR ${table.endedAt} >= ${table.startedAt})`,
    ),
    check('encounters_environment_check', sql`char_length(${table.environment}) <= 2000`),
    check(
      'encounters_visibility_check',
      sql`${table.visibilityMode} = 'everyone' AND ${table.visibilityTargets} = '[]'::jsonb`,
    ),
    check('encounters_version_check', sql`${table.version} >= 1`),
  ],
);

export const encounterGmNotes = pgTable(
  'encounter_gm_notes',
  {
    id: uuid('id').primaryKey(),
    campaignId: uuid('campaign_id').notNull(),
    body: text('body').notNull(),
    visibilityMode: text('visibility_mode').notNull().default('gm_only'),
    ...standard,
  },
  (table) => [
    index('encounter_gm_notes_campaign_idx').on(table.campaignId),
    check('encounter_gm_notes_body_check', sql`char_length(${table.body}) <= 5000`),
    check(
      'encounter_gm_notes_visibility_check',
      sql`${table.visibilityMode} = 'gm_only' AND ${table.visibilityTargets} = '[]'::jsonb`,
    ),
    check('encounter_gm_notes_version_check', sql`${table.version} >= 1`),
  ],
);

export const encounterParticipants = pgTable(
  'encounter_participants',
  {
    id: uuid('id').primaryKey(),
    campaignId: uuid('campaign_id').notNull(),
    encounterId: uuid('encounter_id').notNull(),
    label: text('label').notNull(),
    sourceKind: text('source_kind').notNull(),
    sourceId: uuid('source_id').notNull(),
    position: integer('position').notNull(),
    conditions: jsonb('conditions').$type<Record<string, number>>().notNull().default({}),
    visibilityMode: text('visibility_mode').notNull(),
    ...standard,
  },
  (table) => [
    index('encounter_participants_encounter_idx').on(table.campaignId, table.encounterId),
    check('encounter_participants_label_check', sql`char_length(${table.label}) BETWEEN 1 AND 120`),
    check(
      'encounter_participants_source_check',
      sql`${table.sourceKind} IN ('character', 'entity')
        AND (${table.sourceKind} = 'entity' OR ${table.conditions} = '{}'::jsonb)`,
    ),
    check('encounter_participants_position_check', sql`${table.position} >= 0`),
    check(
      'encounter_participants_conditions_check',
      sql`jsonb_typeof(${table.conditions}) = 'object'`,
    ),
    check(
      'encounter_participants_visibility_check',
      sql`${table.visibilityMode} IN ('everyone', 'gm_only')
        AND ${table.visibilityTargets} = '[]'::jsonb`,
    ),
    check('encounter_participants_version_check', sql`${table.version} >= 1`),
  ],
);

export const encounterParticipantStates = pgTable(
  'encounter_participant_states',
  {
    id: uuid('id').primaryKey(),
    campaignId: uuid('campaign_id').notNull(),
    state: jsonb('state').$type<Record<string, unknown>>().notNull(),
    visibilityMode: text('visibility_mode').notNull().default('gm_only'),
    ...standard,
  },
  (table) => [
    index('encounter_participant_states_campaign_idx').on(table.campaignId),
    check(
      'encounter_participant_states_state_check',
      sql`jsonb_typeof(${table.state}) = 'object' AND octet_length(${table.state}::text) <= 65536`,
    ),
    check(
      'encounter_participant_states_visibility_check',
      sql`${table.visibilityMode} = 'gm_only' AND ${table.visibilityTargets} = '[]'::jsonb`,
    ),
    check('encounter_participant_states_version_check', sql`${table.version} >= 1`),
  ],
);

export const encountersSchema = {
  encounters,
  encounterGmNotes,
  encounterParticipants,
  encounterParticipantStates,
};
