import { afterAll, describe, expect, test } from 'bun:test';
import postgres from 'postgres';
import { connectPortabilityDatabase, PostgresExportJobRepository } from './export-jobs.ts';

/**
 * Feature 07 `_db.md` `export_jobs` against PostgreSQL: idempotent create, lifecycle constraints,
 * active-campaign retention set, and the 30-day database-time retention boundary (exclusive).
 */

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const sql = databaseUrl === undefined ? undefined : postgres(databaseUrl, { max: 2 });
const available = await (async () => {
  if (sql === undefined) return false;
  try {
    await sql`select 1 from export_jobs limit 1`;
    return true;
  } catch {
    return false;
  }
})();
const connection =
  available && databaseUrl !== undefined ? connectPortabilityDatabase(databaseUrl) : undefined;
const created: string[] = [];
afterAll(async () => {
  if (sql !== undefined && created.length > 0) {
    await sql`delete from export_jobs where id = any(${created}::uuid[])`;
  }
  await connection?.close();
  await sql?.end({ timeout: 1 });
});

describe.skipIf(!available)('PostgresExportJobRepository', () => {
  const repository = () => new PostgresExportJobRepository(connection?.db as never);
  const newJob = (campaignId = crypto.randomUUID()) => {
    const id = crypto.randomUUID();
    created.push(id);
    return { id, campaignId, requestedBy: crypto.randomUUID() };
  };

  test('create is idempotent per id and the lifecycle is constrained', async () => {
    if (sql === undefined) return;
    const jobs = repository();
    const input = newJob();
    const first = await jobs.create(input);
    expect(first).toMatchObject({
      created: true,
      job: { state: 'requested', contributorSummary: [] },
    });
    const again = await jobs.create({ ...input, requestedBy: crypto.randomUUID() });
    expect(again.created).toBe(false);
    expect(again.job.requestedBy).toBe(input.requestedBy);

    await jobs.markRunning(input.id);
    expect((await jobs.activeCampaignIds([input.campaignId])).has(input.campaignId)).toBe(true);
    await jobs.complete(input.id, {
      manifestChecksum: 'ab'.repeat(32),
      summary: [{ moduleId: 'campaign', chunkVersion: '1', records: 1, bytes: 10 }],
    });
    const done = await jobs.get(input.id);
    expect(done).toMatchObject({
      state: 'completed',
      manifestChecksum: 'ab'.repeat(32),
      contributorSummary: [{ moduleId: 'campaign', chunkVersion: '1', records: 1, bytes: 10 }],
    });
    expect(done?.completedAt).toBeInstanceOf(Date);
    expect((await jobs.activeCampaignIds([input.campaignId])).size).toBe(0);
    // A terminal job cannot be failed afterwards.
    await jobs.fail(input.id, 'contributor_failed');
    expect((await jobs.get(input.id))?.state).toBe('completed');

    const failed = newJob();
    await jobs.create(failed);
    await jobs.fail(failed.id, 'snapshot_unstable');
    expect(await jobs.get(failed.id)).toMatchObject({
      state: 'failed',
      errorCode: 'snapshot_unstable',
    });

    // The table refuses inconsistent rows directly.
    for (const attempt of [
      sql`insert into export_jobs (id, campaign_id, requested_by, state) values (${crypto.randomUUID()}, ${crypto.randomUUID()}, ${crypto.randomUUID()}, 'completed')`,
      sql`insert into export_jobs (id, campaign_id, requested_by, state, error_code, completed_at) values (${crypto.randomUUID()}, ${crypto.randomUUID()}, ${crypto.randomUUID()}, 'failed', 'Bad Code!', now())`,
      sql`insert into export_jobs (id, campaign_id, requested_by, state) values (${crypto.randomUUID()}, ${crypto.randomUUID()}, ${crypto.randomUUID()}, 'exploded')`,
    ] as Promise<unknown>[]) {
      let code: string | undefined;
      try {
        await attempt;
      } catch (error) {
        code = (error as { code?: string }).code;
      }
      expect(code).toBe('23514');
    }
  });

  test('retention deletes rows strictly older than 30 days in database time', async () => {
    if (sql === undefined) return;
    const jobs = repository();
    const old = newJob();
    const boundary = newJob();
    await jobs.create(old);
    await jobs.create(boundary);
    await sql`update export_jobs set created_at = now() - interval '30 days' - interval '1 minute' where id = ${old.id}`;
    await sql`update export_jobs set created_at = now() - interval '30 days' + interval '1 minute' where id = ${boundary.id}`;
    expect(await jobs.deleteExpired()).toBeGreaterThanOrEqual(1);
    expect(await jobs.get(old.id)).toBeUndefined();
    expect(await jobs.get(boundary.id)).toBeDefined();
  });
});
