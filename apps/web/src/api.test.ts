import { afterEach, describe, expect, test } from 'bun:test';
import { apiRequestAllPages } from './api.ts';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function servePages(pageFor: (url: string) => { items: number[]; nextCursor?: string }) {
  const urls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    return new Response(JSON.stringify(pageFor(url)), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return urls;
}

describe('apiRequestAllPages', () => {
  test('follows nextCursor until the last page and keeps item order', async () => {
    const urls = servePages((url) => {
      if (!url.includes('cursor=')) return { items: [1, 2], nextCursor: 'b c' };
      if (url.endsWith('cursor=b%20c')) return { items: [3, 4], nextCursor: 'd' };
      return { items: [5] };
    });
    expect(await apiRequestAllPages<number>('/campaigns/x/members')).toEqual([1, 2, 3, 4, 5]);
    expect(urls).toEqual([
      '/campaigns/x/members',
      '/campaigns/x/members?cursor=b%20c',
      '/campaigns/x/members?cursor=d',
    ]);
  });

  test('appends the cursor to an existing query string', async () => {
    const urls = servePages((url) =>
      url.includes('cursor=') ? { items: [2] } : { items: [1], nextCursor: 'n' },
    );
    await apiRequestAllPages<number>('/list?limit=1');
    expect(urls).toEqual(['/list?limit=1', '/list?limit=1&cursor=n']);
  });

  test('stops instead of looping forever on a cursor that never ends', async () => {
    const urls = servePages(() => ({ items: [1], nextCursor: 'again' }));
    let failure: unknown;
    try {
      await apiRequestAllPages<number>('/list');
    } catch (error) {
      failure = error;
    }
    expect((failure as Error).message).toBe('too_many_pages');
    expect(urls).toHaveLength(100);
  });
});
