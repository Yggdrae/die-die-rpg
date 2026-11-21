import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Feature 16 `_db.md`: campaign entities of every configured type, and player personal notes.
 * Visibility uses the feature 04 standard columns. The targets CHECK calls
 * `content_visibility_targets_valid(jsonb)` (sorted, unique, lowercase-UUID JSON array), created by
 * the same migration before the tables. No foreign key to `campaigns` (cross-feature table).
 *
 * Lengths are `char_length` (code points), the unit `domain.ts` counts (D-11).
 */

const instant = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

const TOKEN = '^[a-z][a-z0-9_]{0,63}$';

export const contentEntities = pgTable(
  'content_entities',
  {
    id: uuid('id').primaryKey(),
    campaignId: uuid('campaign_id').notNull(),
    type: text('type').notNull(),
    name: text('name').notNull(),
    summary: text('summary').notNull().default(''),
    description: text('description').notNull().default(''),
    tags: jsonb('tags').$type<string[]>().notNull().default([]),
    fields: jsonb('fields').$type<Record<string, string>>().notNull().default({}),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    visibilityMode: text('visibility_mode').notNull(),
    visibilityTargets: jsonb('visibility_targets').$type<string[]>().notNull().default([]),
    version: bigint('version', { mode: 'number' }).notNull().default(1),
    createdAt: instant('created_at').notNull().defaultNow(),
    updatedAt: instant('updated_at').notNull().defaultNow(),
    createdBy: uuid('created_by').notNull(),
    updatedBy: uuid('updated_by').notNull(),
    deletedAt: instant('deleted_at'),
  },
  (table) => [
    // Composite target of the relationship endpoint foreign keys (task 08).
    unique('content_entities_campaign_id_unique').on(table.campaignId, table.id),
    index('content_entities_campaign_type_idx')
      .on(table.campaignId, table.type)
      .where(sql`${table.deletedAt} IS NULL`),
    index('content_entities_campaign_updated_idx')
      .on(table.campaignId, table.updatedAt.desc())
      .where(sql`${table.deletedAt} IS NULL`),
    check('content_entities_type_check', sql.raw(`type ~ '${TOKEN}'`)),
    check(
      'content_entities_name_check',
      sql`char_length(${table.name}) BETWEEN 1 AND 200 AND ${table.name} = btrim(${table.name})
        AND ${table.name} ~ '[^[:space:]]'`,
    ),
    check('content_entities_summary_check', sql`char_length(${table.summary}) <= 280`),
    check('content_entities_description_check', sql`char_length(${table.description}) <= 50000`),
    check(
      'content_entities_tags_check',
      sql`CASE WHEN jsonb_typeof(${table.tags}) = 'array'
        THEN jsonb_array_length(${table.tags}) <= 32 ELSE false END`,
    ),
    check('content_entities_fields_check', sql`jsonb_typeof(${table.fields}) = 'object'`),
    check('content_entities_metadata_check', sql`jsonb_typeof(${table.metadata}) = 'object'`),
    check(
      'content_entities_visibility_mode_check',
      sql`${table.visibilityMode} IN ('gm_only', 'everyone', 'party', 'players')`,
    ),
    check(
      'content_entities_visibility_targets_check',
      sql`CASE WHEN NOT content_visibility_targets_valid(${table.visibilityTargets}) THEN false
        WHEN ${table.visibilityMode} IN ('gm_only', 'everyone')
          THEN ${table.visibilityTargets} = '[]'::jsonb
        ELSE jsonb_array_length(${table.visibilityTargets}) > 0 END`,
    ),
    check('content_entities_version_check', sql`${table.version} >= 1`),
  ],
);

export const contentPersonalNotes = pgTable(
  'content_personal_notes',
  {
    id: uuid('id').primaryKey(),
    campaignId: uuid('campaign_id').notNull(),
    authorUserId: uuid('author_user_id').notNull(),
    name: text('name').notNull(),
    body: text('body').notNull().default(''),
    tags: jsonb('tags').$type<string[]>().notNull().default([]),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    visibilityMode: text('visibility_mode').notNull(),
    visibilityTargets: jsonb('visibility_targets').$type<string[]>().notNull().default([]),
    version: bigint('version', { mode: 'number' }).notNull().default(1),
    createdAt: instant('created_at').notNull().defaultNow(),
    updatedAt: instant('updated_at').notNull().defaultNow(),
    createdBy: uuid('created_by').notNull(),
    updatedBy: uuid('updated_by').notNull(),
    deletedAt: instant('deleted_at'),
  },
  (table) => [
    index('content_personal_notes_author_idx').on(table.campaignId, table.authorUserId),
    check(
      'content_personal_notes_name_check',
      sql`char_length(${table.name}) BETWEEN 1 AND 200 AND ${table.name} = btrim(${table.name})
        AND ${table.name} ~ '[^[:space:]]'`,
    ),
    check('content_personal_notes_body_check', sql`char_length(${table.body}) <= 50000`),
    check(
      'content_personal_notes_tags_check',
      sql`CASE WHEN jsonb_typeof(${table.tags}) = 'array'
        THEN jsonb_array_length(${table.tags}) <= 32 ELSE false END`,
    ),
    check('content_personal_notes_metadata_check', sql`jsonb_typeof(${table.metadata}) = 'object'`),
    // The author is the creator and never changes hands.
    check('content_personal_notes_author_check', sql`${table.authorUserId} = ${table.createdBy}`),
    // Fixed `players:[author]`: a personal note's Visibility can never widen (BR-007).
    check(
      'content_personal_notes_visibility_check',
      sql`${table.visibilityMode} = 'players'
        AND ${table.visibilityTargets} = jsonb_build_array(${table.authorUserId}::text)`,
    ),
    check('content_personal_notes_version_check', sql`${table.version} >= 1`),
  ],
);

/**
 * Typed, directed relationships between two campaign entities (task 08, `_db.md`
 * "`content_entity_relationships`"). Endpoints reference `content_entities (campaign_id, id)`, so
 * both live in the relationship's campaign; `ON DELETE RESTRICT` keeps tombstoned endpoints
 * referenced (broken links). Visibility is bounded by the endpoints' intersection, maintained on
 * write (D-07 option A), not by a CHECK.
 */
export const contentEntityRelationships = pgTable(
  'content_entity_relationships',
  {
    id: uuid('id').primaryKey(),
    campaignId: uuid('campaign_id').notNull(),
    sourceEntityId: uuid('source_entity_id').notNull(),
    targetEntityId: uuid('target_entity_id').notNull(),
    kind: text('kind').notNull(),
    visibilityMode: text('visibility_mode').notNull(),
    visibilityTargets: jsonb('visibility_targets').$type<string[]>().notNull().default([]),
    version: bigint('version', { mode: 'number' }).notNull().default(1),
    createdAt: instant('created_at').notNull().defaultNow(),
    updatedAt: instant('updated_at').notNull().defaultNow(),
    createdBy: uuid('created_by').notNull(),
    updatedBy: uuid('updated_by').notNull(),
    deletedAt: instant('deleted_at'),
  },
  (table) => [
    foreignKey({
      name: 'content_entity_relationships_source_fk',
      columns: [table.campaignId, table.sourceEntityId],
      foreignColumns: [contentEntities.campaignId, contentEntities.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'content_entity_relationships_target_fk',
      columns: [table.campaignId, table.targetEntityId],
      foreignColumns: [contentEntities.campaignId, contentEntities.id],
    }).onDelete('restrict'),
    // One live link per (source, target, kind); a tombstoned duplicate does not block a new one.
    uniqueIndex('content_entity_relationships_live_unique')
      .on(table.campaignId, table.sourceEntityId, table.targetEntityId, table.kind)
      .where(sql`${table.deletedAt} IS NULL`),
    index('content_entity_relationships_source_idx').on(table.campaignId, table.sourceEntityId),
    index('content_entity_relationships_target_idx').on(table.campaignId, table.targetEntityId),
    check(
      'content_entity_relationships_self_link_check',
      sql`${table.sourceEntityId} <> ${table.targetEntityId}`,
    ),
    check('content_entity_relationships_kind_check', sql.raw(`kind ~ '${TOKEN}'`)),
    check(
      'content_entity_relationships_visibility_mode_check',
      sql`${table.visibilityMode} IN ('gm_only', 'everyone', 'party', 'players')`,
    ),
    check(
      'content_entity_relationships_visibility_targets_check',
      sql`CASE WHEN NOT content_visibility_targets_valid(${table.visibilityTargets}) THEN false
        WHEN ${table.visibilityMode} IN ('gm_only', 'everyone')
          THEN ${table.visibilityTargets} = '[]'::jsonb
        ELSE jsonb_array_length(${table.visibilityTargets}) > 0 END`,
    ),
    check('content_entity_relationships_version_check', sql`${table.version} >= 1`),
  ],
);

export const contentSchema = {
  contentEntities,
  contentPersonalNotes,
  contentEntityRelationships,
};
