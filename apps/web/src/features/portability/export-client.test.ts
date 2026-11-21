import { describe, expect, test } from 'bun:test';
import {
  exportCampaign,
  exportOnline,
  type FetchLike,
  type OfflineExportSource,
} from './export-client.ts';
import { browserReplicaExportSource } from './replica-export.ts';

/** Feature 07 tasks 04–05 client behavior (online job + download, offline replica refusal). */

const CAMPAIGN = '00000000-0000-4000-8000-0000000000a1';
const JOB = '00000000-0000-4000-8000-0000000000e1';
const offline = browserReplicaExportSource({ displayName: 'gm', applicationVersion: 'test' });

function fakeServer(input: { start: number; job?: object; fileStatus?: number }) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/exports')) {
      return new Response(JSON.stringify(input.job ?? {}), { status: input.start });
    }
    return new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), {
      status: input.fileStatus ?? 200,
    });
  };
  return { calls, fetchImpl };
}

describe('online export', () => {
  test('acknowledges the warning, waits for the job, and downloads the file', async () => {
    const server = fakeServer({
      start: 201,
      job: {
        jobId: JOB,
        state: 'completed',
        summary: [{ moduleId: 'campaign', chunkVersion: '1', records: 1, bytes: 9 }],
      },
    });
    const outcome = await exportOnline(CAMPAIGN, server.fetchImpl, JOB);
    expect(outcome.kind).toBe('ready');
    if (outcome.kind !== 'ready') return;
    expect(outcome.filename).toBe(`campaign-${JOB}.rpgpack`);
    expect(new Uint8Array(await outcome.file.arrayBuffer())).toEqual(
      new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
    );
    expect(server.calls.map((call) => call.url)).toEqual([
      `/campaigns/${CAMPAIGN}/exports`,
      `/exports/${JOB}/file`,
    ]);
    expect(JSON.parse(String(server.calls[0]?.init.body))).toEqual({
      jobId: JOB,
      acknowledgeGmSecrets: true,
    });
  });

  test('a safe 404 is a denial; a failed job offers no file', async () => {
    expect(await exportOnline(CAMPAIGN, fakeServer({ start: 404 }).fetchImpl)).toEqual({
      kind: 'denied',
    });
    const failed = fakeServer({
      start: 201,
      job: { jobId: JOB, state: 'failed', summary: [], errorCode: 'contributor_failed' },
    });
    expect(await exportOnline(CAMPAIGN, failed.fetchImpl)).toEqual({
      kind: 'failed',
      code: 'contributor_failed',
    });
    expect(failed.calls).toHaveLength(1);
    const gone = fakeServer({
      start: 201,
      job: { jobId: JOB, state: 'completed', summary: [] },
      fileStatus: 410,
    });
    expect(await exportOnline(CAMPAIGN, gone.fetchImpl)).toEqual({
      kind: 'failed',
      code: 'file_unavailable',
    });
  });
});

describe('offline export over the browser replica', () => {
  test('with no open replica it refuses and names every module', async () => {
    expect(await exportCampaign(CAMPAIGN, { online: false, offline })).toEqual({
      kind: 'incomplete_replica',
      modules: [
        'attachments',
        'campaign',
        'characters',
        'content',
        'dice_rolls',
        'encounters',
        'sessions',
      ],
    });
  });

  test('a network failure while online falls back to the replica, never a partial file', async () => {
    const fetchImpl: FetchLike = async () => {
      throw new TypeError('Failed to fetch');
    };
    expect(await exportCampaign(CAMPAIGN, { online: true, offline, fetchImpl })).toEqual({
      kind: 'incomplete_replica',
      modules: [
        'attachments',
        'campaign',
        'characters',
        'content',
        'dice_rolls',
        'encounters',
        'sessions',
      ],
    });
  });

  test('a member who may not export is denied before anything is read', async () => {
    let read = false;
    const denied: OfflineExportSource = {
      ...offline,
      mayExport: async () => false,
      replica: {
        coverage: async () => {
          read = true;
          return { cursor: 'checkpoint', modules: {} };
        },
      },
    };
    expect(await exportCampaign(CAMPAIGN, { online: false, offline: denied })).toEqual({
      kind: 'denied',
    });
    expect(read).toBe(false);
  });
});
