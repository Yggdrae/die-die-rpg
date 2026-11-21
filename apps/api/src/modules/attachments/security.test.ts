import { describe, expect, test } from 'bun:test';
import type { MemoryAttachmentRepository, MemoryObjectStorage } from '@rpg/attachments';
import {
  CASEY,
  GM,
  noteId,
  OTHER_CAMPAIGN,
  ROWAN,
  STRANGER,
} from '../authorization/test-fixture.ts';
import { attachmentApp, CAMPAIGN, headersFor, PDF, PNG, uploadBody } from './test-support.ts';

/**
 * Feature 05 task 07: the attachment security suite over HTTP (real `ContentAccess` and
 * `AuthorizationService`, fixture owner classes, in-memory stores). Provider-level checks
 * (anonymous object reads, bucket listing, foreign CORS origins, forced response types, URL
 * expiry) are in `packages/attachments/src/infra/s3/bun-s3-storage.integration.test.ts`;
 * browser execution in `apps/web/e2e/attachments*.e2e.ts`.
 */

type Harness = ReturnType<typeof attachmentApp>;
type Response = Awaited<ReturnType<Harness['app']['inject']>>;
const NPC = noteId(1);
const OWNER = { resourceClass: 'fixture_note', resourceId: NPC };

function setup(options: Parameters<typeof attachmentApp>[0] = {}) {
  const harness = attachmentApp(options);
  harness.context.notes.put({ id: NPC, visibility: { mode: 'everyone' } });
  return harness;
}

async function attach(harness: Harness, overrides: Parameters<typeof uploadBody>[1] = {}) {
  const bytes = overrides.mime === 'application/pdf' ? PDF : PNG;
  const body = uploadBody(bytes, overrides);
  const permission = await harness.app.inject({
    method: 'POST',
    url: `/campaigns/${CAMPAIGN}/attachments/uploads`,
    headers: headersFor(GM),
    payload: body,
  });
  expect(permission.statusCode).toBe(201);
  const id = permission.json().attachment.attachmentId as string;
  const row = (harness.repository as MemoryAttachmentRepository).rows.get(id);
  if (row === undefined) throw new Error('missing pending row');
  (harness.storage as MemoryObjectStorage).put(row.objectKey, bytes, body.mime);
  const finalized = await harness.app.inject({
    method: 'POST',
    url: `/campaigns/${CAMPAIGN}/attachments/${id}/finalize`,
    headers: headersFor(GM),
    payload: { size: body.size, checksum: body.checksum },
  });
  expect(finalized.statusCode).toBe(200);
  return { id, body, key: row.objectKey };
}

/** One concrete request per registered route, addressing `id` in `campaignId`. */
function concrete(route: { method: string; url: string }, campaignId: string, id: string) {
  const url = route.url
    .replace(':campaignId', campaignId)
    .replace(':attachmentId', id)
    .replace(':class', OWNER.resourceClass)
    .replace(':resourceId', OWNER.resourceId);
  const payload =
    route.method === 'POST'
      ? url.endsWith('/uploads')
        ? uploadBody(PNG)
        : { size: PNG.byteLength, checksum: uploadBody(PNG).checksum }
      : undefined;
  return {
    method: route.method as 'GET' | 'POST' | 'DELETE',
    url: route.method === 'DELETE' ? `${url}?expectedVersion=1` : url,
    ...(payload === undefined ? {} : { payload }),
  };
}

function shape(response: Response) {
  const { date: _date, ...headers } = response.headers;
  return { status: response.statusCode, body: response.body, headers };
}

function issuedUrls(harness: Harness) {
  return (harness.storage as MemoryObjectStorage).grants.length;
}

describe('authorization bypass', () => {
  test('the module registers exactly the expected routes', () => {
    const harness = setup();
    expect(harness.routes.map((route) => `${route.method} ${route.url}`).sort()).toEqual(
      [
        'DELETE /campaigns/:campaignId/attachments/:attachmentId',
        'GET /campaigns/:campaignId/attachments/:attachmentId/read',
        'GET /campaigns/:campaignId/attachments/offline-estimate',
        'GET /campaigns/:campaignId/resources/:class/:resourceId/attachments',
        'POST /campaigns/:campaignId/attachments/:attachmentId/finalize',
        'POST /campaigns/:campaignId/attachments/uploads',
      ].sort(),
    );
  });

  test('no attachment route serves an anonymous caller, an outsider or a foreign campaign', async () => {
    const harness = setup();
    const { id, body } = await attach(harness, { filename: 'Secret Villain.png' });
    const grants = issuedUrls(harness);
    for (const route of harness.routes) {
      const request = concrete(route, CAMPAIGN, id);
      const anonymous = await harness.app.inject({ ...request, headers: headersFor(undefined) });
      expect({ route: request.url, status: anonymous.statusCode }).toEqual({
        route: request.url,
        status: 401,
      });
      const outsider = await harness.app.inject({ ...request, headers: headersFor(STRANGER) });
      const foreign = await harness.app.inject({
        ...concrete(route, OTHER_CAMPAIGN, id),
        headers: headersFor(GM),
      });
      for (const response of [outsider, foreign]) {
        expect({ route: request.url, status: response.statusCode }).toEqual({
          route: request.url,
          status: 404,
        });
        expect(response.body).not.toContain('Secret Villain');
        expect(response.body).not.toContain(body.checksum);
        expect(response.body).not.toContain('memory://');
      }
    }
    expect(issuedUrls(harness)).toBe(grants);
    expect((harness.repository as MemoryAttachmentRepository).rows.size).toBe(1);
    expect((harness.repository as MemoryAttachmentRepository).rows.get(id)?.deletedAt).toBe(
      undefined,
    );
  });

  test('a revoked member loses every route at once with the missing-attachment shape', async () => {
    const harness = setup();
    const { id } = await attach(harness);
    expect(
      (
        await harness.app.inject({
          method: 'GET',
          url: `/campaigns/${CAMPAIGN}/attachments/${id}/read`,
          headers: headersFor(CASEY),
        })
      ).statusCode,
    ).toBe(200);
    harness.context.members.revokeAfter(0);
    const grants = issuedUrls(harness);
    for (const route of harness.routes) {
      const request = concrete(route, CAMPAIGN, id);
      const live = await harness.app.inject({ ...request, headers: headersFor(GM) });
      const missing = await harness.app.inject({
        ...concrete(route, CAMPAIGN, '00000000-0000-4000-8000-00000000dead'),
        headers: headersFor(GM),
      });
      expect({ route: request.url, ...shape(live) }).toEqual({
        route: request.url,
        ...shape(missing),
      });
      expect(live.statusCode).toBe(404);
    }
    expect(issuedUrls(harness)).toBe(grants);
  });

  test('a player cannot reach a GM-only attachment through any route', async () => {
    const harness = setup();
    const { id } = await attach(harness, { visibility: { mode: 'gm_only' } });
    for (const route of harness.routes.filter((entry) => entry.url.includes(':attachmentId'))) {
      const response = await harness.app.inject({
        ...concrete(route, CAMPAIGN, id),
        headers: headersFor(ROWAN),
      });
      expect({ url: route.url, status: response.statusCode }).toEqual({
        url: route.url,
        status: 404,
      });
    }
    const offline = await harness.app.inject({
      method: 'GET',
      url: `/campaigns/${CAMPAIGN}/attachments/offline-estimate`,
      headers: headersFor(ROWAN),
    });
    expect(offline.json() as unknown).toEqual({ items: [], totalBytes: 0 });
  });
});

describe('content-type and HTML smuggling', () => {
  test('active or unlisted types are refused before any grant exists', async () => {
    const harness = setup();
    for (const mime of ['text/html', 'image/svg+xml', 'application/xhtml+xml', 'text/javascript']) {
      const response = await harness.app.inject({
        method: 'POST',
        url: `/campaigns/${CAMPAIGN}/attachments/uploads`,
        headers: headersFor(GM),
        payload: uploadBody(PNG, { mime, filename: 'page.html' }),
      });
      expect({ mime, status: response.statusCode }).toEqual({ mime, status: 415 });
    }
    expect(issuedUrls(harness)).toBe(0);
  });

  test('HTML labelled as an image or a PDF never becomes ready and its bytes are removed', async () => {
    const html = new TextEncoder().encode(
      '<!doctype html><script>parent.document.cookie</script>'.padEnd(96, ' '),
    );
    // A PDF header after leading junk is still not a PDF (no polyglot at offset > 0).
    const junkPdf = new TextEncoder().encode(`<html>${'x'.repeat(20)}%PDF-1.7\n%%EOF`);
    for (const [mime, bytes] of [
      ['image/png', html],
      ['image/jpeg', html],
      ['image/webp', html],
      ['application/pdf', junkPdf],
    ] as const) {
      const harness = setup();
      const body = uploadBody(bytes, { mime, filename: 'innocent.png' });
      const permission = await harness.app.inject({
        method: 'POST',
        url: `/campaigns/${CAMPAIGN}/attachments/uploads`,
        headers: headersFor(GM),
        payload: body,
      });
      const id = permission.json().attachment.attachmentId as string;
      const row = (harness.repository as MemoryAttachmentRepository).rows.get(id);
      if (row === undefined) throw new Error('missing row');
      (harness.storage as MemoryObjectStorage).put(row.objectKey, bytes, 'text/html');
      const finalized = await harness.app.inject({
        method: 'POST',
        url: `/campaigns/${CAMPAIGN}/attachments/${id}/finalize`,
        headers: headersFor(GM),
        payload: { size: body.size, checksum: body.checksum },
      });
      expect({ mime, status: finalized.statusCode, code: finalized.json().code }).toEqual({
        mime,
        status: 422,
        code: 'signature_mismatch',
      });
      expect((harness.storage as MemoryObjectStorage).objects.has(row.objectKey)).toBe(false);
      const read = await harness.app.inject({
        method: 'GET',
        url: `/campaigns/${CAMPAIGN}/attachments/${id}/read`,
        headers: headersFor(GM),
      });
      expect(read.statusCode).toBe(404);
    }
  });

  test('a read grant always names the verified type, never what storage holds', async () => {
    const harness = setup();
    const { id } = await attach(harness, { mime: 'application/pdf', filename: 'letter.pdf' });
    const response = await harness.app.inject({
      method: 'GET',
      url: `/campaigns/${CAMPAIGN}/attachments/${id}/read?disposition=attachment`,
      headers: headersFor(CASEY),
    });
    expect(response.json()).toMatchObject({ mime: 'application/pdf', disposition: 'attachment' });
    expect(response.headers['cache-control']).toBe('no-store');
  });
});

describe('signed URL lifetimes and leakage', () => {
  test('upload grants live ten minutes, read grants five; no other response carries a URL', async () => {
    const harness = setup();
    const before = Date.now();
    const permission = await harness.app.inject({
      method: 'POST',
      url: `/campaigns/${CAMPAIGN}/attachments/uploads`,
      headers: headersFor(GM),
      payload: uploadBody(PNG),
    });
    const uploadLife = Date.parse(permission.json().upload.expiresAt) - before;
    expect(uploadLife).toBeGreaterThanOrEqual(600_000);
    expect(uploadLife).toBeLessThanOrEqual(610_000);
    const { id } = await attach(harness);
    const read = await harness.app.inject({
      method: 'GET',
      url: `/campaigns/${CAMPAIGN}/attachments/${id}/read`,
      headers: headersFor(CASEY),
    });
    const readLife = Date.parse(read.json().expiresAt) - Date.now();
    expect(readLife).toBeGreaterThan(290_000);
    expect(readLife).toBeLessThanOrEqual(300_000);
    for (const url of [
      `/campaigns/${CAMPAIGN}/attachments/offline-estimate`,
      `/campaigns/${CAMPAIGN}/resources/${OWNER.resourceClass}/${OWNER.resourceId}/attachments`,
    ]) {
      const response = await harness.app.inject({ method: 'GET', url, headers: headersFor(GM) });
      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain('memory://');
      expect(response.body).not.toContain('campaigns/');
    }
  });
});

describe('failure handling', () => {
  test('a lost finalize acknowledgement: the retry returns the identical attachment', async () => {
    const harness = setup();
    const body = uploadBody(PNG);
    const permission = await harness.app.inject({
      method: 'POST',
      url: `/campaigns/${CAMPAIGN}/attachments/uploads`,
      headers: headersFor(GM),
      payload: body,
    });
    const id = permission.json().attachment.attachmentId as string;
    const row = (harness.repository as MemoryAttachmentRepository).rows.get(id);
    if (row === undefined) throw new Error('missing row');
    (harness.storage as MemoryObjectStorage).put(row.objectKey, PNG);
    const finalize = () =>
      harness.app.inject({
        method: 'POST',
        url: `/campaigns/${CAMPAIGN}/attachments/${id}/finalize`,
        headers: headersFor(GM),
        payload: { size: body.size, checksum: body.checksum },
      });
    const first = await finalize();
    const retry = await finalize();
    expect(retry.statusCode).toBe(200);
    expect(retry.body).toBe(first.body);
    // One history event, one ready row.
    expect(
      harness.audit.filter((entry) => entry.event.action === 'attachment.uploaded'),
    ).toHaveLength(1);
    expect((harness.repository as MemoryAttachmentRepository).rows.size).toBe(1);
  });

  test('a provider outage during finalize is retryable and never exposes the upload early', async () => {
    const harness = setup();
    const body = uploadBody(PNG);
    const permission = await harness.app.inject({
      method: 'POST',
      url: `/campaigns/${CAMPAIGN}/attachments/uploads`,
      headers: headersFor(GM),
      payload: body,
    });
    const id = permission.json().attachment.attachmentId as string;
    const row = (harness.repository as MemoryAttachmentRepository).rows.get(id);
    if (row === undefined) throw new Error('missing row');
    (harness.storage as MemoryObjectStorage).put(row.objectKey, PNG);
    (harness.storage as MemoryObjectStorage).failing.add('inspect');
    const finalize = () =>
      harness.app.inject({
        method: 'POST',
        url: `/campaigns/${CAMPAIGN}/attachments/${id}/finalize`,
        headers: headersFor(GM),
        payload: { size: body.size, checksum: body.checksum },
      });
    expect((await finalize()).statusCode).toBe(503);
    const offline = await harness.app.inject({
      method: 'GET',
      url: `/campaigns/${CAMPAIGN}/attachments/offline-estimate`,
      headers: headersFor(GM),
    });
    expect(offline.json().items).toEqual([]);
    (harness.storage as MemoryObjectStorage).failing.delete('inspect');
    expect((await finalize()).statusCode).toBe(200);
  });
});

test('log hygiene: no route or failure path logs a URL, key, filename or checksum', async () => {
  const logLines: string[] = [];
  const harness = setup({ logLines });
  const { id, key, body } = await attach(harness, { filename: 'Secret Villain.png' });
  const storage = harness.storage as MemoryObjectStorage;
  for (const route of harness.routes) {
    for (const userId of [GM, CASEY, STRANGER, undefined]) {
      await harness.app.inject({ ...concrete(route, CAMPAIGN, id), headers: headersFor(userId) });
    }
  }
  storage.failing.add('read_grant');
  storage.failing.add('upload');
  for (const route of harness.routes) {
    await harness.app.inject({ ...concrete(route, CAMPAIGN, id), headers: headersFor(GM) });
  }
  const text = logLines.join('\n');
  expect(logLines.length).toBeGreaterThan(20);
  for (const secret of [
    'memory://',
    key,
    'Secret Villain',
    body.checksum,
    'X-Amz',
    'rpg_session',
  ]) {
    expect({ secret, leaked: text.includes(secret) }).toEqual({ secret, leaked: false });
  }
});
