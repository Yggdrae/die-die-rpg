import { describe, expect, test } from 'bun:test';
import { importCampaign } from './import-client.ts';

/** Feature 07 import client: one request, the server's report as the only source of outcomes. */

const JOB = '00000000-0000-4000-8000-0000000000e9';
const NEW = '00000000-0000-4000-8000-0000000000c9';
const file = new Blob([new Uint8Array([0x50, 0x4b, 3, 4])], { type: 'application/zip' });

function respond(status: number, body?: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  return {
    calls,
    fetchImpl: async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(body === undefined ? null : JSON.stringify(body), { status });
    },
  };
}

describe('importCampaign', () => {
  test('sends the file once under the job id and reports the restored modules', async () => {
    const modules = [
      {
        moduleId: 'campaign',
        chunkVersion: '1',
        outcome: 'restored' as const,
        restoredCount: 1,
        warnings: [],
      },
    ];
    const server = respond(201, {
      jobId: JOB,
      state: 'completed',
      campaignId: NEW,
      report: { modules },
      createdAt: '2026-10-28T12:00:00.000Z',
    });
    expect(await importCampaign(file, { fetchImpl: server.fetchImpl, jobId: JOB })).toEqual({
      kind: 'imported',
      campaignId: NEW,
      modules,
    });
    expect(server.calls).toHaveLength(1);
    expect(server.calls[0]?.url).toBe(`/imports/${JOB}`);
    expect(server.calls[0]?.init).toMatchObject({
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/zip' },
      body: file,
    });
  });

  test('a failed job is a rejection with the safe failure details', async () => {
    const server = respond(201, {
      jobId: JOB,
      state: 'failed',
      errorCode: 'system_unavailable',
      failure: { unavailable: { system: { systemId: 'fixture-system', version: '9.9.9' } } },
      report: { modules: [] },
      createdAt: '2026-10-28T12:00:00.000Z',
    });
    expect(await importCampaign(file, { fetchImpl: server.fetchImpl })).toEqual({
      kind: 'rejected',
      code: 'system_unavailable',
      failure: { unavailable: { system: { systemId: 'fixture-system', version: '9.9.9' } } },
    });
  });

  test('offline, oversized, network and HTTP failures never claim an import', async () => {
    const never = respond(500);
    expect(await importCampaign(file, { online: false, fetchImpl: never.fetchImpl })).toEqual({
      kind: 'offline',
    });
    const huge = { size: 250 * 1024 * 1024 + 1 } as Blob;
    expect(await importCampaign(huge, { fetchImpl: never.fetchImpl })).toEqual({
      kind: 'too_large',
    });
    expect(never.calls).toEqual([]);
    expect(await importCampaign(file, { fetchImpl: respond(413).fetchImpl })).toEqual({
      kind: 'too_large',
    });
    expect(await importCampaign(file, { fetchImpl: respond(404).fetchImpl })).toEqual({
      kind: 'failed',
      code: 'http_404',
    });
    expect(
      await importCampaign(file, {
        fetchImpl: async () => {
          throw new TypeError('Failed to fetch');
        },
      }),
    ).toEqual({ kind: 'network_unavailable' });
  });
});
