import { afterAll, describe, expect, test } from 'bun:test';
import type { ImportTransaction } from '@rpg/contracts';
import postgres from 'postgres';
import { canonicalBytes, sha256Hex } from '../../canonical.ts';
import { connectPortabilityDatabase } from './export-jobs.ts';
import {
  importTransactionHandle,
  PostgresImportCommitStore,
  PostgresImportJobRepository,
  PostgresImportTransactions,
  PostgresPreservedChunkSource,
} from './import-jobs.ts';

/**
 * Feature 07 `_db.md` `import_jobs` and `import_preserved_chunks` against PostgreSQL: idempotent
 * create, lifecycle constraints, commit-only completion, rollback of preserved chunks, the
 * closed capability, checksum-verified re-export, and the 90-day retention boundary.
 */

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const sql = databaseUrl === undefined ? undefined : postgres(databaseUrl, { max: 2 });
const available = await (async () => {
  if (sql === undefined) return false;
  try {
    await sql`select 1 from import_jobs limit 1`;
    return true;
  } catch {
    return false;
  }
})();
const connection =
  available && databaseUrl !== undefined ? connectPortabilityDatabase(databaseUrl) : undefined;
const jobs: string[] = [];
const campaigns: string[] = [];
afterAll(async () => {
  if (sql !== undefined) {
    if (jobs.length > 0) await sql`delete from import_jobs where id = any(${jobs}::uuid[])`;
    if (campaigns.length > 0) {
      await sql`delete from import_preserved_chunks where campaign_id = any(${campaigns}::uuid[])`;
    }
  }
  await connection?.close();
  await sql?.end({ timeout: 1 });
});

const newJob = () => {
  const id = crypto.randomUUID();
  jobs.push(id);
  return { id, requestedBy: crypto.randomUUID(), sourceManifestChecksum: 'ab'.repeat(32) };
};
const newCampaign = () => {
  const id = crypto.randomUUID();
  campaigns.push(id);
  return id;
};
const chunk = async (moduleId: string, payload: unknown) => ({
  moduleId,
  chunkVersion: '1',
  payload,
  checksum: await sha256Hex(canonicalBytes(payload)),
});

describe.skipIf(!available)('PostgreSQL import jobs and preserved chunks', () => {
  const db = () => connection?.db as never;

  test('create is idempotent; completion happens only inside the import transaction', async () => {
    if (sql === undefined) return;
    const repository = new PostgresImportJobRepository(db());
    const input = newJob();
    const first = await repository.create(input);
    expect(first).toMatchObject({
      created: true,
      job: { state: 'running', sourceManifestChecksum: 'ab'.repeat(32), report: { modules: [] } },
    });
    const again = await repository.create({ ...input, requestedBy: crypto.randomUUID() });
    expect(again.created).toBe(false);
    expect(again.job.requestedBy).toBe(input.requestedBy);

    const campaignId = newCampaign();
    const transactions = new PostgresImportTransactions(db());
    const store = new PostgresImportCommitStore();
    let captured: ImportTransaction | undefined;
    const report = {
      modules: [
        {
          moduleId: 'campaign',
          chunkVersion: '1',
          outcome: 'restored' as const,
          restoredCount: 1,
          warnings: [],
        },
      ],
    };
    await transactions.run(async (transaction) => {
      captured = transaction;
      await store.preserve(transaction, campaignId, [await chunk('future', { b: 2, a: [1] })]);
      await store.completeJob(transaction, input.id, campaignId, report);
    });
    // The capability is closed once its transaction settled.
    expect(() => importTransactionHandle(captured as ImportTransaction)).toThrow(
      'import_transaction_not_open',
    );
    expect(await repository.get(input.id)).toMatchObject({
      state: 'completed',
      campaignId,
      report,
    });
    // A completed job never fails afterwards, and cannot complete twice.
    await repository.fail(input.id, 'import_failed', {});
    expect((await repository.get(input.id))?.state).toBe('completed');
    let reused: unknown;
    try {
      await transactions.run((transaction) =>
        store.completeJob(transaction, input.id, newCampaign(), report),
      );
    } catch (error) {
      reused = error;
    }
    expect(String(reused)).toContain('import_job_not_running');

    const exported = await new PostgresPreservedChunkSource(db()).list(campaignId);
    expect(exported).toEqual([
      { moduleId: 'future', chunkVersion: '1', payload: { a: [1], b: 2 } },
    ]);
  });

  test('a throw inside the transaction leaves no preserved chunk and a running job', async () => {
    if (sql === undefined) return;
    const repository = new PostgresImportJobRepository(db());
    const input = newJob();
    await repository.create(input);
    const campaignId = newCampaign();
    const store = new PostgresImportCommitStore();
    let failed = false;
    try {
      await new PostgresImportTransactions(db()).run(async (transaction) => {
        await store.preserve(transaction, campaignId, [await chunk('future', { x: 1 })]);
        await store.completeJob(transaction, input.id, campaignId, { modules: [] });
        throw new Error('contributor failed');
      });
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
    const [row] =
      await sql`select count(*)::int as n from import_preserved_chunks where campaign_id = ${campaignId}`;
    expect(row?.n).toBe(0);
    expect((await repository.get(input.id))?.state).toBe('running');

    await repository.fail(input.id, 'contributor_failed', {
      moduleId: 'npcs',
      detail: 'x_missing',
    });
    expect(await repository.get(input.id)).toMatchObject({
      state: 'failed',
      errorCode: 'contributor_failed',
      failure: { moduleId: 'npcs', detail: 'x_missing' },
      report: { modules: [] },
    });
    expect((await repository.get(input.id))?.campaignId).toBeUndefined();
  });

  test('the tables refuse inconsistent rows, and tampered preserved payloads never export', async () => {
    if (sql === undefined) return;
    for (const attempt of [
      sql`insert into import_jobs (id, requested_by, state) values (${crypto.randomUUID()}, ${crypto.randomUUID()}, 'completed')`,
      sql`insert into import_jobs (id, requested_by, state, error_code, completed_at) values (${crypto.randomUUID()}, ${crypto.randomUUID()}, 'failed', 'Bad Code!', now())`,
      sql`insert into import_jobs (id, requested_by, state, report) values (${crypto.randomUUID()}, ${crypto.randomUUID()}, 'running', '[]'::jsonb)`,
      sql`insert into import_preserved_chunks (campaign_id, module_id, chunk_version, payload, payload_checksum) values (${crypto.randomUUID()}, '../etc', '1', '{}'::jsonb, decode(${'00'.repeat(32)}, 'hex'))`,
      sql`insert into import_preserved_chunks (campaign_id, module_id, chunk_version, payload, payload_checksum) values (${crypto.randomUUID()}, 'ok', '1', '{}'::jsonb, decode('00', 'hex'))`,
    ] as Promise<unknown>[]) {
      let code: string | undefined;
      try {
        await attempt;
      } catch (error) {
        code = (error as { code?: string }).code;
      }
      expect(code).toBe('23514');
    }

    const campaignId = newCampaign();
    await new PostgresImportTransactions(db()).run(async (transaction) =>
      new PostgresImportCommitStore().preserve(transaction, campaignId, [
        await chunk('future', { kept: true }),
      ]),
    );
    await sql`update import_preserved_chunks set payload = '{"kept":false}'::jsonb where campaign_id = ${campaignId}`;
    let refused: unknown;
    try {
      await new PostgresPreservedChunkSource(db()).list(campaignId);
    } catch (error) {
      refused = error;
    }
    expect(String(refused)).toContain('preserved_chunk_checksum_mismatch');
  });

  test('retention deletes jobs strictly older than 90 days in database time', async () => {
    if (sql === undefined) return;
    const repository = new PostgresImportJobRepository(db());
    const old = newJob();
    const boundary = newJob();
    await repository.create(old);
    await repository.create(boundary);
    await sql`update import_jobs set created_at = now() - interval '90 days' - interval '1 minute' where id = ${old.id}`;
    await sql`update import_jobs set created_at = now() - interval '90 days' + interval '1 minute' where id = ${boundary.id}`;
    expect(await repository.deleteExpired()).toBeGreaterThanOrEqual(1);
    expect(await repository.get(old.id)).toBeUndefined();
    expect(await repository.get(boundary.id)).toBeDefined();
  });
});
