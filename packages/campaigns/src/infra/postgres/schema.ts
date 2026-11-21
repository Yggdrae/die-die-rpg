import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

const instant = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const campaigns = pgTable(
  'campaigns',
  {
    id: uuid('id').primaryKey(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    gameMode: text('game_mode').notNull(),
    createdBy: uuid('created_by').notNull(),
    version: bigint('version', { mode: 'number' }).notNull().default(1),
    createdAt: instant('created_at').notNull().defaultNow(),
    updatedAt: instant('updated_at').notNull().defaultNow(),
    deletedAt: instant('deleted_at'),
  },
  (table) => [
    index('campaigns_active_updated_idx')
      .on(table.updatedAt.desc())
      .where(sql`${table.deletedAt} IS NULL`),
    index('campaigns_created_by_idx').on(table.createdBy),
    index('campaigns_deleted_idx').on(table.deletedAt),
    check(
      'campaigns_name_check',
      sql`char_length(btrim(${table.name})) BETWEEN 1 AND 120 AND ${table.name} = btrim(${table.name})`,
    ),
    check('campaigns_description_check', sql`char_length(${table.description}) <= 10000`),
    check('campaigns_game_mode_check', sql`char_length(${table.gameMode}) >= 1`),
    check('campaigns_version_check', sql`${table.version} >= 1`),
  ],
);

export const campaignSystemPins = pgTable('campaign_system_pins', {
  campaignId: uuid('campaign_id')
    .primaryKey()
    .references(() => campaigns.id, { onDelete: 'restrict' }),
  systemId: text('system_id').notNull(),
  systemVersion: text('system_version').notNull(),
  updatedAt: instant('updated_at').notNull().defaultNow(),
});

export const campaignModulePins = pgTable(
  'campaign_module_pins',
  {
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'restrict' }),
    moduleId: text('module_id').notNull(),
    moduleVersion: text('module_version').notNull(),
    createdAt: instant('created_at').notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.campaignId, table.moduleId] })],
);

export const campaignSettings = pgTable(
  'campaign_settings',
  {
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'restrict' }),
    namespace: text('namespace').notNull(),
    value: jsonb('value').notNull(),
    memberVisible: boolean('member_visible').notNull(),
    version: bigint('version', { mode: 'number' }).notNull().default(1),
    updatedAt: instant('updated_at').notNull().defaultNow(),
    updatedBy: uuid('updated_by').notNull(),
    deletedAt: instant('deleted_at'),
  },
  (table) => [
    primaryKey({ columns: [table.campaignId, table.namespace] }),
    check(
      'campaign_settings_namespace_check',
      sql`octet_length(${table.namespace}) BETWEEN 1 AND 100 AND ${table.namespace} COLLATE "C" ~ '^[a-z0-9][a-z0-9._-]{0,99}$'`,
    ),
    check('campaign_settings_version_check', sql`${table.version} >= 1`),
  ],
);

export const campaignSchema = {
  campaignModulePins,
  campaignSettings,
  campaignSystemPins,
  campaigns,
};
