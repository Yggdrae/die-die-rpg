import { describe, expect, test } from 'bun:test';
import type { FetchLike } from './attachments-api.ts';
import { httpOfflineAttachmentSource } from './offline-source.ts';

/**
 * Feature 05 task 05: the offline store's network side. A 404 is a denial; every other failure is
 * retryable and never permission; bytes come only from a separate-origin grant, fetched without
 * cookies or referrer.
 */

const APP = 'http://127.0.0.1:4173';
const STORAGE = 'http://localhost:9000/rpg-attachments/campaigns/a/b/c?X-Amz-Signature=x';
const CAMPAIGN = '00000000-0000-4000-8000-0000000000a1';
const OTHER = '00000000-0000-4000-8000-0000000000a2';
const ID = '00000000-0000-4000-8000-000000009001';

function grant(url = STORAGE) {
  return {
    attachmentId: ID,
    method: 'GET',
    url,
    expiresAt: '2026-10-27T12:05:00.000Z',
    mime: 'image/png',
    disposition: 'inline',
  };
}

function stub(routes: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return routes(url, init);
  };
  return { calls, source: httpOfflineAttachmentSource(fetchImpl, APP) };
}

describe('offline set', () => {
  test('a 200 lists only items of the asked campaign; 404 is a denial; anything else is offline', async () => {
    const items = [
      { attachmentId: ID, campaignId: CAMPAIGN },
      { attachmentId: ID, campaignId: OTHER },
    ];
    const ok = stub(() => Response.json({ items, totalBytes: 1 }));
    expect(await ok.source.offlineSet(CAMPAIGN)).toEqual({
      kind: 'ok',
      items: [items[0]] as never,
    });
    expect(ok.calls[0]?.url).toBe(`/campaigns/${CAMPAIGN}/attachments/offline-estimate`);
    expect(ok.calls[0]?.init.credentials).toBe('include');
    const denied = stub(() => Response.json({ code: 'not_found_or_forbidden' }, { status: 404 }));
    expect(await denied.source.offlineSet(CAMPAIGN)).toEqual({ kind: 'denied' });
    for (const failure of [
      () => new Response('', { status: 503 }),
      () => Response.json({ nope: true }),
      () => {
        throw new TypeError('network');
      },
    ]) {
      expect(await stub(failure).source.offlineSet(CAMPAIGN)).toEqual({ kind: 'offline' });
    }
  });
});

describe('download and check', () => {
  test('downloads from the granted storage URL without cookies or referrer, reporting progress', async () => {
    const bytes = new Uint8Array(300).map((_, index) => index % 251);
    const { calls, source } = stub((url) =>
      url.startsWith('/campaigns/')
        ? Response.json(grant())
        : new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(bytes.subarray(0, 100));
                controller.enqueue(bytes.subarray(100));
                controller.close();
              },
            }),
          ),
    );
    const progress: number[] = [];
    const result = await source.download(CAMPAIGN, ID, {
      signal: new AbortController().signal,
      onProgress: (value) => progress.push(value),
    });
    expect(result.kind === 'ok' && [...result.bytes]).toEqual([...bytes]);
    expect(progress).toEqual([100, 300]);
    expect(calls[0]?.url).toBe(`/campaigns/${CAMPAIGN}/attachments/${ID}/read?disposition=inline`);
    expect(calls[1]?.url).toBe(STORAGE);
    expect(calls[1]?.init).toMatchObject({
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      mode: 'cors',
      cache: 'no-store',
    });
  });

  test('a denied grant, an unsafe URL or a storage error never yields bytes', async () => {
    const denied = stub(() => Response.json({}, { status: 404 }));
    const options = { signal: new AbortController().signal, onProgress: () => undefined };
    expect(await denied.source.download(CAMPAIGN, ID, options)).toEqual({ kind: 'denied' });
    for (const url of [`${APP}/evil`, 'javascript:alert(1)', 'blob:http://127.0.0.1:4173/x']) {
      const unsafe = stub(() => Response.json(grant(url)));
      expect(await unsafe.source.download(CAMPAIGN, ID, options)).toEqual({ kind: 'failed' });
      expect(unsafe.calls).toHaveLength(1);
    }
    const expired = stub((url) =>
      url.startsWith('/campaigns/') ? Response.json(grant()) : new Response('', { status: 403 }),
    );
    expect(await expired.source.download(CAMPAIGN, ID, options)).toEqual({ kind: 'failed' });
  });

  test('a read check maps 404 to denied, a grant to allowed, a network error to offline', async () => {
    expect(await stub(() => Response.json({}, { status: 404 })).source.check(CAMPAIGN, ID)).toBe(
      'denied',
    );
    expect(await stub(() => Response.json(grant())).source.check(CAMPAIGN, ID)).toBe('allowed');
    expect(
      await stub(() => {
        throw new TypeError('offline');
      }).source.check(CAMPAIGN, ID),
    ).toBe('offline');
  });
});
