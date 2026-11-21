import type { ImportTransaction } from '@rpg/contracts';
import { type SQL, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { canonicalBytes, sha256Hex } from '../../canonical.ts';
import type { PreservedChunk } from '../../format.ts';
import {
  IMPORT_JOB_RETENTION_DAYS,
  type ImportFailureDetails,
  type ImportJob,
  type ImportJobRepository,
  type ImportJobState,
} from '../../import-jobs.ts';
import type {
  ImportCommitStore,
  ImportFailureCode,
  ImportReport,
  ImportTransactionRunner,
  PreservedChunkRow,
} from '../../importer.ts';
import type { PreservedChunkSource } from '../../orchestrator.ts';
import type { portabilitySchema } from './schema.ts';

type Database = PostgresJsDatabase<typeof portabilitySchema>;

/** Anything that runs a Drizzle SQL statement: the database or an open transaction. */
interface SqlExecutor {
  execute<T extends Record<string, unknown>>(query: SQL): Promise<T[]>;
}

/**
 * Open import transactions by capability. The capability object is the only thing contributors
 * see; the composition root resolves it with `importTransactionHandle` and hands the handle to
 * each contributor's own persistence adapter. A capability stops resolving once its transaction
 * settled, so a contributor cannot write after commit or rollback.
 */
const OPEN = new WeakMap<ImportTransaction, SqlExecutor>();

/** One PostgreSQL transaction per import, opened by feature 07 (`_db.md`, Atomic Import step 5). */
export class PostgresImportTransactions implements ImportTransactionRunner {
  constructor(private readonly db: Database) {}

  run<T>(work: (transaction: ImportTransaction) => Promise<T>): Promise<T> {
    return this.db.transaction(async (handle) => {
      const capability: ImportTransaction = Object.freeze({ brand: 'ImportTransaction' as const });
      OPEN.set(capability, handle as unknown as SqlExecutor);
      try {
        return await work(capability);
      } finally {
        OPEN.delete(capability);
      }
    });
  }
}

/**
 * Composition-root only: the SQL executor behind an open import transaction, for a
 * contributor's own adapter (feature 02 `createWithin`, feature 01 `createOwner`).
 */
export function importTransactionHandle(transaction: ImportTransaction): unknown {
  const handle = OPEN.get(transaction);
  if (handle === undefined) throw new Error('import_transaction_not_open');
  return handle;
}

function executorOf(transaction: ImportTransaction): SqlExecutor {
  return importTransactionHandle(transaction) as SqlExecutor;
}

/** Feature 07's own writes inside the import transaction. */
export class PostgresImportCommitStore implements ImportCommitStore {
  async preserve(
    transaction: ImportTransaction,
    campaignId: string,
    chunks: readonly PreservedChunkRow[],
  ) {
    const executor = executorOf(transaction);
    for (const chunk of chunks) {
      await executor.execute(sql`
        INSERT INTO import_preserved_chunks
          (campaign_id, module_id, chunk_version, payload, payload_checksum)
        VALUES (${campaignId}, ${chunk.moduleId}, ${chunk.chunkVersion},
          ${JSON.stringify(chunk.payload)}::jsonb, decode(${chunk.checksum}, 'hex'))
      `);
    }
  }

  async completeJob(
    transaction: ImportTransaction,
    jobId: string,
    campaignId: string,
    report: ImportReport,
  ) {
    const rows = await executorOf(transaction).execute<{ id: string }>(sql`
      UPDATE import_jobs SET state = 'completed', campaign_id = ${campaignId},
        report = ${JSON.stringify(report)}::jsonb, completed_at = now()
      WHERE id = ${jobId} AND state = 'running'
      RETURNING id
    `);
    // A job that is no longer running must not gain a campaign: roll the import back.
    if (rows.length !== 1) throw new Error('import_job_not_running');
  }
}

interface Row extends Record<string, unknown> {
  id: string;
  requested_by: string;
  source_manifest_checksum: string | null;
  state: string;
  campaign_id: string | null;
  report: unknown;
  error_code: string | null;
  created_at: Date | string;
  completed_at: Date | string | null;
}

const COLUMNS = sql.raw(`
  id, requested_by, encode(source_manifest_checksum, 'hex') AS source_manifest_checksum, state,
  campaign_id, report, error_code, created_at, completed_at
`);

/** Database-time retention predicate (exclusive): a job exactly at the boundary is kept. */
const EXPIRED = sql.raw(`created_at < now() - interval '${IMPORT_JOB_RETENTION_DAYS} days'`);

export class PostgresImportJobRepository implements ImportJobRepository {
  constructor(private readonly db: Database) {}

  async create(input: { id: string; requestedBy: string; sourceManifestChecksum?: string }) {
    const checksum = input.sourceManifestChecksum;
    const inserted = await this.#one(sql`
      INSERT INTO import_jobs (id, requested_by, source_manifest_checksum, state)
      VALUES (${input.id}, ${input.requestedBy},
        ${checksum === undefined ? null : sql`decode(${checksum}, 'hex')`}, 'running')
      ON CONFLICT (id) DO NOTHING
      RETURNING ${COLUMNS}
    `);
    if (inserted !== undefined) return { job: inserted, created: true };
    const existing = await this.get(input.id);
    if (existing === undefined) throw new Error('import job vanished during create');
    return { job: existing, created: false };
  }

  async fail(id: string, code: ImportFailureCode, details: ImportFailureDetails) {
    await this.db.execute(sql`
      UPDATE import_jobs SET state = 'failed', error_code = ${code},
        report = ${JSON.stringify({ modules: [], failure: details })}::jsonb, completed_at = now()
      WHERE id = ${id} AND state = 'running'
    `);
  }

  get(id: string) {
    return this.#one(sql`SELECT ${COLUMNS} FROM import_jobs WHERE id = ${id}`);
  }

  async deleteExpired() {
    const rows = await this.db.execute<{ id: string }>(
      sql`DELETE FROM import_jobs WHERE ${EXPIRED} RETURNING id`,
    );
    return rows.length;
  }

  async #one(query: SQL): Promise<ImportJob | undefined> {
    const [row] = await this.db.execute<Row>(query);
    return row === undefined ? undefined : toJob(row);
  }
}

function toJob(row: Row): ImportJob {
  const stored = (row.report ?? {}) as { modules?: unknown; failure?: unknown };
  return {
    id: row.id,
    requestedBy: row.requested_by,
    ...(row.source_manifest_checksum === null
      ? {}
      : { sourceManifestChecksum: row.source_manifest_checksum }),
    state: row.state as ImportJobState,
    ...(row.campaign_id === null ? {} : { campaignId: row.campaign_id }),
    report: { modules: Array.isArray(stored.modules) ? stored.modules : [] },
    ...(stored.failure !== null && typeof stored.failure === 'object'
      ? { failure: stored.failure as ImportFailureDetails }
      : {}),
    ...(row.error_code === null ? {} : { errorCode: row.error_code as ImportFailureCode }),
    createdAt: new Date(row.created_at),
    ...(row.completed_at === null ? {} : { completedAt: new Date(row.completed_at) }),
  };
}

/**
 * Export side of preserved chunks (`PreservedChunkSource`): re-emitted byte-for-byte canonically
 * under `unknown/`. A payload whose canonical checksum no longer matches is never exported.
 */
export class PostgresPreservedChunkSource implements PreservedChunkSource {
  constructor(private readonly db: Database) {}

  async list(campaignId: string): Promise<readonly PreservedChunk[]> {
    const rows = await this.db.execute<{
      module_id: string;
      chunk_version: string;
      payload: unknown;
      checksum: string;
    }>(sql`
      SELECT module_id, chunk_version, payload, encode(payload_checksum, 'hex') AS checksum
      FROM import_preserved_chunks WHERE campaign_id = ${campaignId}
      ORDER BY module_id, chunk_version
    `);
    const chunks: PreservedChunk[] = [];
    for (const row of rows) {
      if ((await sha256Hex(canonicalBytes(row.payload))) !== row.checksum) {
        throw new Error('preserved_chunk_checksum_mismatch');
      }
      chunks.push({
        moduleId: row.module_id,
        chunkVersion: row.chunk_version,
        payload: row.payload,
      });
    }
    return chunks;
  }
}
