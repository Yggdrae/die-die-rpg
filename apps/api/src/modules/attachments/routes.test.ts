import { describe, expect, test } from 'bun:test';
import { MemoryAttachmentRepository, type MemoryObjectStorage } from '@rpg/attachments';
import {
  CASEY,
  GM,
  NOTE,
  noteId,
  OBSERVER,
  OTHER_CAMPAIGN,
  ROWAN,
  SECRET,
  STRANGER,
} from '../authorization/test-fixture.ts';
import { attachmentApp, CAMPAIGN, headersFor, PDF, PNG, uploadBody } from './test-support.ts';

/**
 * Feature 05 tasks 03–04 over HTTP: the real `ContentAccess` and `AuthorizationService` with the
 * feature 04 fixture owner classes; in-memory storage and metadata (the PostgreSQL and MinIO
 * paths are proved in `attachments.integration.test.ts`).
 */

type Harness = ReturnType<typeof attachmentApp>;
const NPC = noteId(1);
const HIDDEN = noteId(2);
const CASEY_NOTE = noteId(3);

function setup(options: Parameters<typeof attachmentApp>[0] = {}) {
  const harness = attachmentApp(options);
  harness.context.notes.put({ id: NPC, visibility: { mode: 'everyone' } });
  harness.context.notes.put({ id: HIDDEN, visibility: { mode: 'gm_only' } });
  harness.context.secrets.put({
    id: CASEY_NOTE,
    visibility: { mode: 'everyone' },
    authorUserId: CASEY,
  });
  return harness;
}

const owner = (resourceId = NPC, resourceClass = NOTE) => ({ resourceClass, resourceId });

async function requestUpload(
  harness: Harness,
  userId: string | undefined,
  body: unknown,
  campaignId = CAMPAIGN,
) {
  return harness.app.inject({
    method: 'POST',
    url: `/campaigns/${campaignId}/attachments/uploads`,
    headers: headersFor(userId),
    payload: body as Record<string, unknown>,
  });
}

async function finalize(harness: Harness, userId: string, id: string, body: unknown) {
  return harness.app.inject({
    method: 'POST',
    url: `/campaigns/${CAMPAIGN}/attachments/${id}/finalize`,
    headers: headersFor(userId),
    payload: body as Record<string, unknown>,
  });
}

function read(harness: Harness, userId: string | undefined, id: string, campaignId = CAMPAIGN) {
  return harness.app.inject({
    method: 'GET',
    url: `/campaigns/${campaignId}/attachments/${id}/read`,
    headers: headersFor(userId),
  });
}

function list(harness: Harness, userId: string, resourceId = NPC, resourceClass = NOTE) {
  return harness.app.inject({
    method: 'GET',
    url: `/campaigns/${CAMPAIGN}/resources/${resourceClass}/${resourceId}/attachments`,
    headers: headersFor(userId),
  });
}

/** Upload permission, direct upload of `bytes`, finalize; returns the ready attachment ID. */
async function attach(
  harness: Harness,
  overrides: Parameters<typeof uploadBody>[1] = {},
  bytes = overrides.mime === 'application/pdf' ? PDF : PNG,
  userId = GM,
) {
  const body = uploadBody(bytes, overrides);
  const permission = await requestUpload(harness, userId, body);
  expect(permission.statusCode).toBe(201);
  const id = permission.json().attachment.attachmentId as string;
  const row = (harness.repository as MemoryAttachmentRepository).rows.get(id);
  if (row === undefined) throw new Error('missing pending row');
  (harness.storage as MemoryObjectStorage).put(row.objectKey, bytes, body.mime);
  const finalized = await finalize(harness, userId, id, {
    size: body.size,
    checksum: body.checksum,
  });
  expect(finalized.statusCode).toBe(200);
  return { id, body, row };
}

/** Status, body and every header but `date`. */
function shape(response: Awaited<ReturnType<Harness['app']['inject']>>) {
  const { date: _date, ...headers } = response.headers;
  return { status: response.statusCode, body: response.body, headers };
}

describe('POST /campaigns/:campaignId/attachments/uploads (task 03)', () => {
  test('an allowed GM receives one pending attachment and one no-store upload grant', async () => {
    const harness = setup();
    const response = await requestUpload(harness, GM, uploadBody(PNG));
    expect(response.statusCode).toBe(201);
    expect(response.headers['cache-control']).toBe('no-store');
    const body = response.json();
    expect(body.attachment.status).toBe('pending');
    expect(body.upload).toMatchObject({ method: 'PUT', headers: { 'content-type': 'image/png' } });
    expect(Object.keys(body).sort()).toEqual(['attachment', 'upload']);
    expect(response.body).not.toContain('harbor-map');
  });

  // Scenario Outline: An unauthorized actor receives no upload destination.
  test('every denial is byte-identical to an unmatched route and issues nothing', async () => {
    const harness = setup();
    const unmatched = await harness.app.inject({ method: 'GET', url: '/no/such/route' });
    const denied = [
      await requestUpload(harness, CASEY, uploadBody(PNG)),
      await requestUpload(harness, OBSERVER, uploadBody(PNG)),
      await requestUpload(harness, STRANGER, uploadBody(PNG)),
      await requestUpload(harness, GM, uploadBody(PNG), OTHER_CAMPAIGN),
      await requestUpload(harness, GM, uploadBody(PNG, { owner: owner(noteId(99)) })),
      await requestUpload(harness, GM, uploadBody(PNG, { owner: owner(NPC, 'npc') })),
      await requestUpload(harness, GM, uploadBody(PNG, { owner: owner(CASEY_NOTE, SECRET) })),
      await requestUpload(harness, GM, uploadBody(PNG, { owner: owner(NPC, 'campaign') })),
    ];
    for (const response of denied) expect(shape(response)).toEqual(shape(unmatched));
    expect((harness.storage as MemoryObjectStorage).grants).toHaveLength(0);
    expect((harness.repository as MemoryAttachmentRepository).rows.size).toBe(0);
  });

  test('file policy answers only an allowed actor, with clear errors', async () => {
    const harness = setup();
    const cases: [Parameters<typeof uploadBody>[1], number, string][] = [
      [{ mime: 'image/svg+xml' }, 415, 'unsupported_file_type'],
      [{ mime: 'text/html' }, 415, 'unsupported_file_type'],
      [{ size: 26_214_401 }, 413, 'file_too_large'],
      [{ filename: '../secret.png' }, 400, 'validation_failed'],
      [{ checksum: 'nope' }, 400, 'validation_failed'],
      [{ visibility: { mode: 'party', partyIds: [NPC] } }, 400, 'validation_failed'],
      [{ visibility: { mode: 'players', playerIds: [STRANGER] } }, 400, 'validation_failed'],
    ];
    for (const [overrides, status, code] of cases) {
      const response = await requestUpload(harness, GM, uploadBody(PNG, overrides));
      expect({ overrides, status: response.statusCode, code: response.json().code }).toEqual({
        overrides,
        status,
        code,
      });
      const outsider = await requestUpload(harness, STRANGER, uploadBody(PNG, overrides));
      expect(outsider.statusCode).toBe(404);
    }
    const tooLarge = await requestUpload(harness, GM, uploadBody(PNG, { size: 26_214_401 }));
    expect(tooLarge.json() as unknown).toEqual({
      code: 'file_too_large',
      message: 'Files are limited to 25 MB.',
      details: { maxBytes: 26_214_400 },
    });
    const exact = await requestUpload(harness, GM, uploadBody(PNG, { size: 26_214_400 }));
    expect(exact.statusCode).toBe(201);
    expect((harness.storage as MemoryObjectStorage).grants).toHaveLength(1);
  });

  test('the body cannot name a role, an actor or a storage target', async () => {
    const harness = setup();
    for (const extra of [{ role: 'gm' }, { actorUserId: GM }, { bucket: 'x' }, { key: 'k' }]) {
      const response = await requestUpload(harness, CASEY, { ...uploadBody(PNG), ...extra });
      expect(response.statusCode).toBe(400);
    }
    const spoofed = await harness.app.inject({
      method: 'POST',
      url: `/campaigns/${CAMPAIGN}/attachments/uploads`,
      headers: { ...headersFor(CASEY), 'x-role': 'gm', 'x-campaign-role': 'owner' },
      payload: uploadBody(PNG) as unknown as Record<string, unknown>,
    });
    expect(spoofed.statusCode).toBe(404);
  });

  test('401 without a session, 403 from another origin', async () => {
    const harness = setup();
    expect((await requestUpload(harness, undefined, uploadBody(PNG))).statusCode).toBe(401);
    const foreign = await harness.app.inject({
      method: 'POST',
      url: `/campaigns/${CAMPAIGN}/attachments/uploads`,
      headers: { ...headersFor(GM), origin: 'https://evil.invalid' },
      payload: uploadBody(PNG) as unknown as Record<string, unknown>,
    });
    expect(foreign.statusCode).toBe(403);
  });

  test('a provider fault answers 503 with no grant', async () => {
    const harness = setup();
    (harness.storage as MemoryObjectStorage).failing.add('upload');
    const response = await requestUpload(harness, GM, uploadBody(PNG));
    expect(response.statusCode).toBe(503);
    expect(response.json().code).toBe('storage_unavailable');
  });
});

describe('POST /campaigns/:campaignId/attachments/:id/finalize (task 03)', () => {
  test('verified finalize makes it ready; an identical retry returns the same attachment', async () => {
    const harness = setup();
    const { id, body } = await attach(harness);
    const retry = await finalize(harness, GM, id, { size: body.size, checksum: body.checksum });
    expect(retry.statusCode).toBe(200);
    expect(retry.json().attachment).toMatchObject({
      attachmentId: id,
      status: 'ready',
      mime: 'image/png',
      size: PNG.byteLength,
      owner: owner(),
    });
    expect(harness.audit).toHaveLength(1);
    expect((harness.repository as MemoryAttachmentRepository).rows.size).toBe(1);
  });

  test('mismatches are 422 and leave nothing listed or readable', async () => {
    const harness = setup();
    const body = uploadBody(PNG);
    const permission = await requestUpload(harness, GM, body);
    const id = permission.json().attachment.attachmentId as string;
    const early = await finalize(harness, GM, id, { size: body.size, checksum: body.checksum });
    expect([early.statusCode, early.json().code]).toEqual([409, 'upload_incomplete']);
    const row = (harness.repository as MemoryAttachmentRepository).rows.get(id);
    if (row === undefined) throw new Error('missing row');
    const html = new TextEncoder().encode(
      '<html><script>fetch("/campaigns").then(r=>r.text())</script></html>'.padEnd(96, ' '),
    );
    (harness.storage as MemoryObjectStorage).put(row.objectKey, html, 'text/html');
    const wrongClaim = await finalize(harness, GM, id, { size: 95, checksum: body.checksum });
    expect([wrongClaim.statusCode, wrongClaim.json().code]).toEqual([422, 'size_mismatch']);
    const stored = await finalize(harness, GM, id, { size: body.size, checksum: body.checksum });
    expect([stored.statusCode, stored.json().code]).toEqual([422, 'checksum_mismatch']);
    const after = await finalize(harness, GM, id, { size: body.size, checksum: body.checksum });
    expect([after.statusCode, after.json().code]).toEqual([409, 'upload_failed']);
    expect((await list(harness, GM)).json() as unknown).toEqual({ items: [] });
    expect((await read(harness, GM, id)).statusCode).toBe(404);
  });

  test('another member, a demoted uploader or a stranger gets the safe 404', async () => {
    const harness = setup();
    const body = uploadBody(PNG);
    const permission = await requestUpload(harness, GM, body);
    const id = permission.json().attachment.attachmentId as string;
    const missing = await finalize(harness, CASEY, '00000000-0000-4000-8000-00000000dead', body);
    for (const userId of [CASEY, ROWAN, OBSERVER, STRANGER]) {
      expect(shape(await finalize(harness, userId, id, body))).toEqual(shape(missing));
    }
  });
});

describe('list and read (task 04)', () => {
  test('lists hold only permitted attachments; a hidden owner equals a missing one', async () => {
    // Lists order by creation time, then id: uploads within one millisecond would sort by random id.
    let second = 0;
    const harness = setup({
      repository: new MemoryAttachmentRepository(() => {
        second += 1;
        return new Date(second * 1000);
      }),
    });
    const shared = await attach(harness);
    const gmOnly = await attach(harness, { visibility: { mode: 'gm_only' } });
    const forRowan = await attach(harness, { visibility: { mode: 'players', playerIds: [ROWAN] } });
    const ids = (response: Awaited<ReturnType<typeof list>>) =>
      (response.json().items as { attachmentId: string }[]).map((item) => item.attachmentId);
    expect(ids(await list(harness, GM))).toEqual([shared.id, gmOnly.id, forRowan.id]);
    expect(ids(await list(harness, CASEY))).toEqual([shared.id]);
    expect(ids(await list(harness, ROWAN))).toEqual([shared.id, forRowan.id]);
    const caseyList = (await list(harness, CASEY)).body;
    expect(caseyList).not.toContain(gmOnly.id);
    expect(caseyList).not.toContain('campaigns/');
    expect(shape(await list(harness, CASEY, HIDDEN))).toEqual(
      shape(await list(harness, CASEY, noteId(98))),
    );
    for (const userId of [OBSERVER, STRANGER]) {
      expect((await list(harness, userId)).statusCode).toBe(404);
    }
    expect(harness.access.inventory.violations()).toEqual([]);
    await harness.app.ready();
  });

  // Scenario: An authorized viewer receives a temporary read destination.
  test('an allowed viewer gets a no-store five-minute grant with the declared type', async () => {
    const harness = setup();
    const { id } = await attach(harness, { mime: 'application/pdf', filename: 'letter.pdf' });
    const response = await read(harness, CASEY, id);
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const grant = response.json();
    expect(grant).toMatchObject({ attachmentId: id, method: 'GET', mime: 'application/pdf' });
    expect(grant.disposition).toBe('inline');
    const remaining = Date.parse(grant.expiresAt) - Date.now();
    expect(remaining).toBeGreaterThan(290_000);
    expect(remaining).toBeLessThanOrEqual(300_000);
    const download = await harness.app.inject({
      method: 'GET',
      url: `/campaigns/${CAMPAIGN}/attachments/${id}/read?disposition=attachment`,
      headers: headersFor(CASEY),
    });
    expect(download.json().disposition).toBe('attachment');
  });

  // Scenario: A hidden attachment does not leak through resolution.
  test('hidden, missing, pending, foreign and tombstoned attachments are byte-identical', async () => {
    const harness = setup();
    const gmOnly = await attach(harness, { visibility: { mode: 'gm_only' } });
    const onHidden = await attach(harness, { owner: owner(HIDDEN) });
    const tombstoned = await attach(harness);
    (harness.repository as MemoryAttachmentRepository).tombstone(tombstoned.id);
    const pending = (await requestUpload(harness, GM, uploadBody(PNG))).json().attachment
      .attachmentId as string;
    const missing = shape(await read(harness, CASEY, '00000000-0000-4000-8000-00000000dead'));
    const grantsBefore = (harness.storage as MemoryObjectStorage).grants.length;
    for (const id of [gmOnly.id, onHidden.id, tombstoned.id, pending]) {
      expect(shape(await read(harness, CASEY, id))).toEqual(missing);
    }
    expect(shape(await read(harness, STRANGER, gmOnly.id))).toEqual(missing);
    expect(shape(await read(harness, GM, gmOnly.id, OTHER_CAMPAIGN))).toEqual(missing);
    expect((harness.storage as MemoryObjectStorage).grants.length).toBe(grantsBefore);
    expect(missing.body).not.toContain('harbor-map');
  });

  // Scenario: A leaked read URL ages out (renewal side).
  test('renewal after access loss is denied: narrowing, owner narrowing, revocation', async () => {
    const harness = setup();
    const { id } = await attach(harness);
    expect((await read(harness, CASEY, id)).statusCode).toBe(200);
    (harness.repository as MemoryAttachmentRepository).setVisibility(id, { mode: 'gm_only' });
    expect((await read(harness, CASEY, id)).statusCode).toBe(404);
    (harness.repository as MemoryAttachmentRepository).setVisibility(id, { mode: 'everyone' });
    const note = harness.context.notes.rows.get(NPC);
    if (note === undefined) throw new Error('missing note');
    note.visibility = { mode: 'gm_only' };
    expect((await read(harness, CASEY, id)).statusCode).toBe(404);
    note.visibility = { mode: 'everyone' };
    expect((await read(harness, CASEY, id)).statusCode).toBe(200);
    harness.context.members.revokeAfter(0);
    expect((await read(harness, CASEY, id)).statusCode).toBe(404);
    expect((await read(harness, GM, id)).statusCode).toBe(404);
  });

  test('author-private owners: only the author may list or read, GM roles included', async () => {
    const harness = setup();
    const { id } = await attach(harness, { owner: owner(CASEY_NOTE, SECRET) }, PNG, CASEY);
    expect((await read(harness, CASEY, id)).statusCode).toBe(200);
    expect((await read(harness, GM, id)).statusCode).toBe(404);
    expect((await list(harness, GM, CASEY_NOTE, SECRET)).statusCode).toBe(404);
    expect((await read(harness, ROWAN, id)).statusCode).toBe(404);
  });

  test('a read with a provider fault is 503 only for an allowed actor', async () => {
    const harness = setup();
    const { id } = await attach(harness);
    (harness.storage as MemoryObjectStorage).failing.add('read_grant');
    expect((await read(harness, CASEY, id)).statusCode).toBe(503);
    expect((await read(harness, STRANGER, id)).statusCode).toBe(404);
  });
});

test('logs never carry a signed URL, object key or filename', async () => {
  const logLines: string[] = [];
  const harness = setup({ logLines });
  const { id, row } = await attach(harness, { filename: 'Secret Villain.png' });
  await read(harness, GM, id);
  await read(harness, CASEY, '00000000-0000-4000-8000-00000000dead');
  (harness.storage as MemoryObjectStorage).failing.add('read_grant');
  await read(harness, GM, id);
  const text = logLines.join('\n');
  expect(logLines.length).toBeGreaterThan(5);
  expect(text).not.toContain('memory://');
  expect(text).not.toContain(row.objectKey);
  expect(text).not.toContain('Secret Villain');
  expect(text).not.toContain('X-Amz');
});
