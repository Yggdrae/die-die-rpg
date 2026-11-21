import { sql } from 'drizzle-orm';
import { bigint, check, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Feature 15 `_db.md`: characters and their GM-only half (D-06). Visibility is fixed: `players:[owner]` for a
 * character, `gm_only` for its secret row. No foreign key to campaigns (cross-feature table).
 */

const instant = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const characters = pgTable(
  'characters',
  {
    id: uuid('id').primaryKey(),
    campaignId: uuid('campaign_id').notNull(),
    ownerUserId: uuid('owner_user_id').notNull(),
    systemId: text('system_id').notNull(),
    systemVersion: text('system_version').notNull(),
    state: jsonb('state').$type<unknown>().notNull(),
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
    index('characters_campaign_idx').on(table.campaignId).where(sql`${table.deletedAt} IS NULL`),
    check('characters_owner_check', sql`${table.ownerUserId} = ${table.createdBy}`),
    check('characters_state_check', sql`jsonb_typeof(${table.state}) = 'object'`),
    check('characters_version_check', sql`${table.version} >= 1`),
    check(
      'characters_visibility_check',
      sql`${table.visibilityMode} = 'players'
        AND ${table.visibilityTargets} = jsonb_build_array(${table.ownerUserId}::text)`,
    ),
  ],
);

export const characterSecrets = pgTable(
  'character_secrets',
  {
    id: uuid('id').primaryKey(),
    campaignId: uuid('campaign_id').notNull(),
    state: jsonb('state').$type<unknown>().notNull(),
    visibilityMode: text('visibility_mode').notNull().default('gm_only'),
    visibilityTargets: jsonb('visibility_targets').$type<string[]>().notNull().default([]),
    version: bigint('version', { mode: 'number' }).notNull().default(1),
    updatedAt: instant('updated_at').notNull().defaultNow(),
    deletedAt: instant('deleted_at'),
  },
  (table) => [
    index('character_secrets_campaign_idx').on(table.campaignId),
    check('character_secrets_state_check', sql`jsonb_typeof(${table.state}) = 'object'`),
    check('character_secrets_version_check', sql`${table.version} >= 1`),
    check(
      'character_secrets_visibility_check',
      sql`${table.visibilityMode} = 'gm_only' AND ${table.visibilityTargets} = '[]'::jsonb`,
    ),
  ],
);

export const charactersSchema = { characters, characterSecrets };
