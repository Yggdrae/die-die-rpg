import { describe, expect, test } from 'bun:test';
import { err } from '@rpg/contracts';
import {
  EXPORT_JOB_RETENTION_DAYS,
  MemoryExportJobRepository,
  OnlineExportService,
  TemporaryPackageStore,
} from './jobs.ts';
import { ExportOrchestrator } from './orchestrator.ts';
import { ExportRegistry } from './registry.ts';
import { CAMPAIGN_ID } from './test-fixtures.ts';

/** Feature 07 task 04: job lifecycle, retry idempotency, delivery window, and retention. */

const USER = '2c1d0e9f-8a7b-4c6d-9e5f-4a3b2c1d0e9f';
const OTHER = '3d2e1f0a-9b8c-4d7e-8f6a-5b4c3d2e1f0a';
const DAY = 86_400_000;

function setup(options: { failing?: boolean } = {}) {
  let clock = Date.parse('2026-10-27T12:00:00.000Z');
  let exports = 0;
  const registry = new ExportRegistry()
    .register(
      {
        moduleId: 'campaign',
        export: async () => {
          exports += 1;
          if (options.failing) throw new Error('database password=hunter2 unreachable');
          return { moduleId: 'campaign', chunkVersion: '1', payload: { name: 'Road' } };
        },
        import: async () => err('x'),
      },
      { placement: 'campaign', countRecords: () => 1 },
    )
    .register(
      {
        moduleId: 'attachments',
        export: async () => ({
          moduleId: 'attachments',
          chunkVersion: '1',
          payload: { entries: [] },
        }),
        import: async () => err('x'),
      },
      { placement: 'attachments-manifest', countRecords: () => 0 },
    );
  const orchestrator = new ExportOrchestrator({
    registry,
    rules: {
      pins: async () => ({ system: { systemId: 'fixture-system', version: '1.0.0' }, modules: [] }),
    },
    applicationVersion: 'test',
  });
  const jobs = new MemoryExportJobRepository(() => new Date(clock));
  const files = new TemporaryPackageStore(10 * 60 * 1000, () => clock);
  const failures: string[] = [];
  const service = new OnlineExportService({
    jobs,
    orchestrator,
    files,
    log: { exportFailed: (code, moduleId) => failures.push(`${code}:${moduleId ?? ''}`) },
  });
  return {
    service,
    jobs,
    files,
    failures,
    exports: () => exports,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

const start = (
  service: OnlineExportService,
  jobId: string,
  userId = USER,
  campaignId = CAMPAIGN_ID,
) => service.start({ jobId, campaignId, userId, displayName: 'Rowan' });

describe('online export job', () => {
  test('completes with safe metadata; a retry with the same id never regenerates', async () => {
    const { service, jobs, exports } = setup();
    const jobId = crypto.randomUUID();
    const first = await start(service, jobId);
    expect(first.ok && first.value).toMatchObject({
      jobId,
      state: 'completed',
      summary: [
        { moduleId: 'attachments', records: 0 },
        { moduleId: 'campaign', records: 1 },
      ],
      fileAvailableUntil: '2026-10-27T12:10:00.000Z',
    });
    const job = await jobs.get(jobId);
    expect(job?.manifestChecksum).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(job)).not.toContain('Road');
    const readsAfterFirst = exports();
    const retried = await start(service, jobId);
    expect(retried).toEqual(first);
    expect(exports()).toBe(readsAfterFirst);
  });

  test('a job id belonging to another user or campaign is a conflict', async () => {
    const { service } = setup();
    const jobId = crypto.randomUUID();
    await start(service, jobId);
    expect(await start(service, jobId, OTHER)).toEqual({ ok: false, error: 'job_conflict' });
    expect(await start(service, jobId, USER, crypto.randomUUID())).toEqual({
      ok: false,
      error: 'job_conflict',
    });
  });

  test('a contributor failure fails the job with a safe code and holds no bytes', async () => {
    const { service, files, failures, jobs } = setup({ failing: true });
    const jobId = crypto.randomUUID();
    const result = await start(service, jobId);
    expect(result.ok && result.value).toMatchObject({
      state: 'failed',
      errorCode: 'contributor_failed',
    });
    expect(result.ok && result.value.fileAvailableUntil).toBeUndefined();
    expect(files.heldCount).toBe(0);
    expect(service.file(jobId, USER)).toBeUndefined();
    expect(failures).toEqual(['contributor_failed:campaign']);
    expect(JSON.stringify(await jobs.get(jobId))).not.toContain('hunter2');
  });

  test('the file is only for its requester, inside the window, and leaves on delivery', async () => {
    const { service, files, advance } = setup();
    const delivered = crypto.randomUUID();
    await start(service, delivered);
    expect(service.file(delivered, OTHER)).toBeUndefined();
    expect(service.file(delivered, USER)?.size).toBeGreaterThan(0);
    service.delivered(delivered);
    expect(service.file(delivered, USER)).toBeUndefined();

    const expiring = crypto.randomUUID();
    await start(service, expiring);
    advance(10 * 60 * 1000 - 1);
    expect(service.file(expiring, USER)).toBeDefined();
    advance(1);
    expect(service.file(expiring, USER)).toBeUndefined();
    expect(files.heldCount).toBe(0);
    expect((await service.status(expiring, USER))?.fileAvailableUntil).toBeUndefined();
    expect(await service.status(expiring, OTHER)).toBeUndefined();
  });

  test('metadata is retained 30 days, then deleted; active jobs retain campaigns', async () => {
    const { service, jobs, advance } = setup();
    const jobId = crypto.randomUUID();
    await start(service, jobId);
    const pending = await jobs.create({
      id: crypto.randomUUID(),
      campaignId: OTHER,
      requestedBy: USER,
    });
    expect(pending.created).toBe(true);
    expect(await jobs.activeCampaignIds([CAMPAIGN_ID, OTHER])).toEqual(new Set([OTHER]));
    advance(EXPORT_JOB_RETENTION_DAYS * DAY);
    expect(await jobs.deleteExpired()).toBe(0);
    advance(1);
    expect(await jobs.deleteExpired()).toBe(2);
    expect(await jobs.get(jobId)).toBeUndefined();
  });
});
