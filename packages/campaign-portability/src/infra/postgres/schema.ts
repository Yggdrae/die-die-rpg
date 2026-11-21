import { sql } from 'drizzle-orm';
import {
  check,
  customType,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Feature 07 `_db.md`, `export_jobs`: safe job metadata only. No package bytes, no payload, no
 * secret and no download URL are ever stored; the summary carries module ids, chunk versions,
 * record counts and byte sizes. Retained 30 days, then hard-deleted.
 */

const instant = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => 'bytea',
});

export const exportJobs = pgTable(
  'export_jobs',
  {
    id: uuid('id').primaryKey(),
    campaignId: uuid('campaign_id').notNull(),
    requestedBy: uuid('requested_by').notNull(),
    state: text('state').notNull().default('requested'),
    manifestChecksum: bytea('manifest_checksum'),
    contributorSummary: jsonb('contributor_summary').notNull().default([]),
    createdAt: instant('created_at').notNull().defaultNow(),
    completedAt: instant('completed_at'),
    errorCode: text('error_code'),
  },
  (table) => [
    index('export_jobs_created_idx').on(table.createdAt),
    index('export_jobs_active_campaign_idx')
      .on(table.campaignId)
      .where(sql`${table.state} IN ('requested', 'running')`),
    check(
      'export_jobs_state_check',
      sql`${table.state} IN ('requested', 'running', 'completed', 'failed')`,
    ),
    // Terminal exactly when completed; evidence exactly when completed; a code exactly on failure.
    check(
      'export_jobs_lifecycle_check',
      sql`(${table.state} IN ('completed', 'failed')) = (${table.completedAt} IS NOT NULL)
        AND (${table.state} = 'completed') = (${table.manifestChecksum} IS NOT NULL)
        AND (${table.state} = 'failed') = (${table.errorCode} IS NOT NULL)`,
    ),
    check(
      'export_jobs_manifest_checksum_check',
      sql`${table.manifestChecksum} IS NULL OR octet_length(${table.manifestChecksum}) = 32`,
    ),
    check('export_jobs_error_code_check', sql`${table.errorCode} ~ '^[a-z_]{1,64}$'`),
    check('export_jobs_summary_check', sql`jsonb_typeof(${table.contributorSummary}) = 'array'`),
  ],
);

/**
 * Feature 07 `_db.md`, `import_jobs`: idempotent orchestration and the safe report. The new
 * campaign id is set only inside the import transaction's commit; a failed job carries a safe
 * code and safe failure details (module id, contributor code, unavailable pins), never package
 * content. Retained 90 days, then hard-deleted.
 */
export const importJobs = pgTable(
  'import_jobs',
  {
    id: uuid('id').primaryKey(),
    requestedBy: uuid('requested_by').notNull(),
    /** SHA-256 of the package's `manifest.json`; null when the package never got that far. */
    sourceManifestChecksum: bytea('source_manifest_checksum'),
    state: text('state').notNull().default('running'),
    campaignId: uuid('campaign_id'),
    report: jsonb('report').notNull().default({}),
    errorCode: text('error_code'),
    createdAt: instant('created_at').notNull().defaultNow(),
    completedAt: instant('completed_at'),
  },
  (table) => [
    index('import_jobs_created_idx').on(table.createdAt),
    check('import_jobs_state_check', sql`${table.state} IN ('running', 'completed', 'failed')`),
    // Terminal exactly when completed; a campaign exactly on success; a code exactly on failure.
    check(
      'import_jobs_lifecycle_check',
      sql`(${table.state} IN ('completed', 'failed')) = (${table.completedAt} IS NOT NULL)
        AND (${table.state} = 'completed') = (${table.campaignId} IS NOT NULL)
        AND (${table.state} = 'failed') = (${table.errorCode} IS NOT NULL)`,
    ),
    check(
      'import_jobs_manifest_checksum_check',
      sql`${table.sourceManifestChecksum} IS NULL OR octet_length(${table.sourceManifestChecksum}) = 32`,
    ),
    check('import_jobs_error_code_check', sql`${table.errorCode} ~ '^[a-z_]{1,64}$'`),
    check('import_jobs_report_check', sql`jsonb_typeof(${table.report}) = 'object'`),
  ],
);

/**
 * Feature 07 `_db.md`, `import_preserved_chunks`: opaque chunks an import did not restore (an
 * unknown module, a contributor without the transaction-aware contract, an unsupported chunk
 * version, or a chunk the package itself preserved). Bounded JSON that is never interpreted,
 * queried as domain data, synchronized or executed. Export re-emits it under `unknown/` after
 * checking `payload_checksum` (SHA-256 of its canonical JSON). Written only inside the import
 * transaction, so a failed import leaves none.
 */
export const importPreservedChunks = pgTable(
  'import_preserved_chunks',
  {
    campaignId: uuid('campaign_id').notNull(),
    moduleId: text('module_id').notNull(),
    chunkVersion: text('chunk_version').notNull(),
    payload: jsonb('payload').notNull(),
    payloadChecksum: bytea('payload_checksum').notNull(),
    createdAt: instant('created_at').notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.campaignId, table.moduleId, table.chunkVersion] }),
    check(
      'import_preserved_chunks_module_id_check',
      sql`${table.moduleId} ~ '^[a-z][a-z0-9_-]{0,63}$'`,
    ),
    check(
      'import_preserved_chunks_chunk_version_check',
      sql`${table.chunkVersion} ~ '^[0-9A-Za-z][0-9A-Za-z._-]{0,31}$'`,
    ),
    check(
      'import_preserved_chunks_checksum_check',
      sql`octet_length(${table.payloadChecksum}) = 32`,
    ),
  ],
);

export const portabilitySchema = { exportJobs, importJobs, importPreservedChunks };
