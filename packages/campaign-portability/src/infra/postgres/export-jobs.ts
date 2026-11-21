import { sql } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import {
  EXPORT_JOB_RETENTION_DAYS,
  type ExportJob,
  type ExportJobRepository,
  type ExportJobState,
} from '../../jobs.ts';
import type { ContributorSummary } from '../../schemas.ts';
import { portabilitySchema } from './schema.ts';

type Database = PostgresJsDatabase<typeof portabilitySchema>;

interface Row extends Record<string, unknown> {
  id: string;
  campaign_id: string;
  requested_by: string;
  state: string;
  manifest_checksum: string | null;
  contributor_summary: unknown;
  error_code: string | null;
  created_at: Date | string;
  completed_at: Date | string | null;
}

const COLUMNS = sql.raw(`
  id, campaign_id, requested_by, state, encode(manifest_checksum, 'hex') AS manifest_checksum,
  contributor_summary, error_code, created_at, completed_at
`);

/** Database-time retention predicate (exclusive): a job exactly at the boundary is kept. */
const EXPIRED = sql.raw(`created_at < now() - interval '${EXPORT_JOB_RETENTION_DAYS} days'`);

export class PostgresExportJobRepository implements ExportJobRepository {
  constructor(private readonly db: Database) {}

  async create(input: { id: string; campaignId: string; requestedBy: string }) {
    const inserted = await this.#one(sql`
      INSERT INTO export_jobs (id, campaign_id, requested_by, state)
      VALUES (${input.id}, ${input.campaignId}, ${input.requestedBy}, 'requested')
      ON CONFLICT (id) DO NOTHING
      RETURNING ${COLUMNS}
    `);
    if (inserted !== undefined) return { job: inserted, created: true };
    const existing = await this.get(input.id);
    if (existing === undefined) throw new Error('export job vanished during create');
    return { job: existing, created: false };
  }

  async markRunning(id: string) {
    await this.db.execute(
      sql`UPDATE export_jobs SET state = 'running' WHERE id = ${id} AND state = 'requested'`,
    );
  }

  async complete(
    id: string,
    result: { manifestChecksum: string; summary: readonly ContributorSummary[] },
  ) {
    await this.db.execute(sql`
      UPDATE export_jobs SET
        state = 'completed',
        manifest_checksum = decode(${result.manifestChecksum}, 'hex'),
        contributor_summary = ${JSON.stringify(result.summary)}::jsonb,
        completed_at = now()
      WHERE id = ${id} AND state IN ('requested', 'running')
    `);
  }

  async fail(id: string, errorCode: ExportJob['errorCode']) {
    await this.db.execute(sql`
      UPDATE export_jobs SET state = 'failed', error_code = ${errorCode ?? 'export_failed'},
        completed_at = now()
      WHERE id = ${id} AND state IN ('requested', 'running')
    `);
  }

  get(id: string) {
    return this.#one(sql`SELECT ${COLUMNS} FROM export_jobs WHERE id = ${id}`);
  }

  async activeCampaignIds(campaignIds: readonly string[]) {
    if (campaignIds.length === 0) return new Set<string>();
    const rows = await this.db.execute<{ campaign_id: string }>(sql`
      SELECT DISTINCT campaign_id FROM export_jobs
      WHERE state IN ('requested', 'running')
        AND campaign_id = ANY(${`{${campaignIds.join(',')}}`}::uuid[])
    `);
    return new Set(rows.map((row) => row.campaign_id));
  }

  async deleteExpired() {
    const rows = await this.db.execute<{ id: string }>(
      sql`DELETE FROM export_jobs WHERE ${EXPIRED} RETURNING id`,
    );
    return rows.length;
  }

  async #one(query: ReturnType<typeof sql>): Promise<ExportJob | undefined> {
    const [row] = await this.db.execute<Row>(query);
    return row === undefined ? undefined : toJob(row);
  }
}

function toJob(row: Row): ExportJob {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    requestedBy: row.requested_by,
    state: row.state as ExportJobState,
    ...(row.manifest_checksum === null ? {} : { manifestChecksum: row.manifest_checksum }),
    contributorSummary: Array.isArray(row.contributor_summary)
      ? (row.contributor_summary as ContributorSummary[])
      : [],
    ...(row.error_code === null ? {} : { errorCode: row.error_code as ExportJob['errorCode'] }),
    createdAt: new Date(row.created_at),
    ...(row.completed_at === null ? {} : { completedAt: new Date(row.completed_at) }),
  };
}

export function connectPortabilityDatabase(
  connectionString: string,
  options: { max?: number } = {},
) {
  const client = postgres(connectionString, {
    max: options.max ?? 3,
    prepare: false,
    onnotice: () => undefined,
  });
  return {
    db: drizzle(client, { schema: portabilitySchema, logger: false }),
    close: async () => client.end(),
  };
}
