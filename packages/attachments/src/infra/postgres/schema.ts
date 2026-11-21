import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  customType,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Feature 05 `_db.md`: attachment metadata only. Bytes live in object storage; the only binary
 * columns are the two 32-byte SHA-256 digests. Visibility uses the feature 04 standard columns.
 */

const instant = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => 'bytea',
});

const MIME_CHECK = sql.raw(`('application/pdf', 'image/jpeg', 'image/png', 'image/webp')`);
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

export const attachments = pgTable(
  'attachments',
  {
    id: uuid('id').primaryKey(),
    campaignId: uuid('campaign_id').notNull(),
    ownerResourceClass: text('owner_resource_class').notNull(),
    ownerResourceId: uuid('owner_resource_id').notNull(),
    filename: text('filename').notNull(),
    mimeType: text('mime_type').notNull(),
    declaredSize: bigint('declared_size', { mode: 'number' }).notNull(),
    verifiedSize: bigint('verified_size', { mode: 'number' }),
    declaredChecksum: bytea('declared_checksum').notNull(),
    verifiedChecksum: bytea('verified_checksum'),
    objectKey: text('object_key').notNull(),
    status: text('status').notNull().default('pending'),
    visibilityMode: text('visibility_mode').notNull(),
    visibilityTargets: jsonb('visibility_targets').$type<string[]>().notNull().default([]),
    version: bigint('version', { mode: 'number' }).notNull().default(1),
    createdAt: instant('created_at').notNull().defaultNow(),
    updatedAt: instant('updated_at').notNull().defaultNow(),
    createdBy: uuid('created_by').notNull(),
    updatedBy: uuid('updated_by').notNull(),
    finalizedAt: instant('finalized_at'),
    failedAt: instant('failed_at'),
    deletedAt: instant('deleted_at'),
    purgeAfter: instant('purge_after'),
  },
  (table) => [
    uniqueIndex('attachments_object_key_unique').on(table.objectKey),
    index('attachments_owner_idx').on(
      table.campaignId,
      table.ownerResourceClass,
      table.ownerResourceId,
    ),
    index('attachments_pending_created_idx')
      .on(table.createdAt)
      .where(sql`${table.status} = 'pending'`),
    index('attachments_ready_campaign_idx')
      .on(table.campaignId)
      .where(sql`${table.status} = 'ready' AND ${table.deletedAt} IS NULL`),
    index('attachments_purge_idx').on(table.purgeAfter).where(sql`${table.deletedAt} IS NOT NULL`),
    check(
      'attachments_owner_class_check',
      sql`${table.ownerResourceClass} ~ '^[a-z][a-z0-9_]{0,63}$'`,
    ),
    // 1–255 code points; no C0/C1 control, DEL, or path separator; not blank or a dot segment.
    check(
      'attachments_filename_check',
      sql`char_length(${table.filename}) BETWEEN 1 AND 255
        AND ${table.filename} !~ '[\\x01-\\x1f\\x7f-\\x9f/\\\\]'
        AND btrim(${table.filename}) <> ''
        AND ${table.filename} NOT IN ('.', '..')`,
    ),
    check('attachments_mime_check', sql`${table.mimeType} IN ${MIME_CHECK}`),
    check('attachments_declared_size_check', sql`${table.declaredSize} BETWEEN 1 AND 26214400`),
    check(
      'attachments_verified_size_check',
      sql`${table.verifiedSize} IS NULL OR ${table.verifiedSize} = ${table.declaredSize}`,
    ),
    check('attachments_declared_checksum_check', sql`octet_length(${table.declaredChecksum}) = 32`),
    check(
      'attachments_verified_checksum_check',
      sql`${table.verifiedChecksum} IS NULL OR ${table.verifiedChecksum} = ${table.declaredChecksum}`,
    ),
    check(
      'attachments_object_key_check',
      sql.raw(`object_key ~ '^campaigns/${UUID}/${UUID}/${UUID}$'`),
    ),
    check('attachments_status_check', sql`${table.status} IN ('pending', 'ready', 'failed')`),
    // Only a verified row is ready; only a failed row has a failure instant.
    check(
      'attachments_lifecycle_check',
      sql`(${table.status} = 'ready') = (${table.verifiedSize} IS NOT NULL AND ${table.verifiedChecksum} IS NOT NULL AND ${table.finalizedAt} IS NOT NULL)
        AND (${table.status} = 'failed') = (${table.failedAt} IS NOT NULL)`,
    ),
    // Only ready attachments are deleted (tombstoned); the purge deadline exists exactly then.
    check(
      'attachments_deletion_check',
      sql`(${table.deletedAt} IS NULL OR ${table.status} = 'ready')
        AND (${table.deletedAt} IS NULL) = (${table.purgeAfter} IS NULL)`,
    ),
    check(
      'attachments_visibility_mode_check',
      sql`${table.visibilityMode} IN ('gm_only', 'everyone', 'party', 'players')`,
    ),
    check(
      'attachments_visibility_targets_check',
      sql`jsonb_typeof(${table.visibilityTargets}) = 'array' AND (
        (${table.visibilityMode} IN ('gm_only', 'everyone') AND ${table.visibilityTargets} = '[]'::jsonb)
        OR (${table.visibilityMode} IN ('party', 'players') AND jsonb_array_length(${table.visibilityTargets}) > 0)
      )`,
    ),
    check('attachments_version_check', sql`${table.version} >= 1`),
  ],
);

export const attachmentSchema = { attachments };
