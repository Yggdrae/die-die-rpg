import { describe, expect, test } from 'bun:test';
import type { MemoryAttachmentRepository, MemoryObjectStorage } from '@rpg/attachments';
import {
  CASEY,
  GM,
  noteId,
  OBSERVER,
  OTHER_CAMPAIGN,
  ROWAN,
  STRANGER,
} from '../authorization/test-fixture.ts';
import { attachmentApp, CAMPAIGN, headersFor, PNG, uploadBody } from './test-support.ts';

/**
 * Feature 05 tasks 05–06 over HTTP with the real `ContentAccess` and the feature 04 fixture owner
 * classes: the campaign offline set (`GET .../attachments/offline-estimate`) and versioned
 * deletion (`DELETE .../attachments/:id`). Hidden and missing answers are byte-identical.
 */

type Harness = ReturnType<typeof attachmentApp>;
const NPC = noteId(1);
const HIDDEN = noteId(2);

function setup(options: Parameters<typeof attachmentApp>[0] = {}) {
  const harness = attachmentApp(options);
  harness.context.notes.put({ id: NPC, visibility: { mode: 'everyone' } });
  harness.context.notes.put({ id: HIDDEN, visibility: { mode: 'gm_only' } });
  return harness;
}

async function attach(harness: Harness, overrides: Parameters<typeof uploadBody>[1] = {}) {
  const body = uploadBody(PNG, overrides);
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
  (harness.storage as MemoryObjectStorage).put(row.objectKey, PNG, body.mime);
  const finalized = await harness.app.inject({
    method: 'POST',
    url: `/campaigns/${CAMPAIGN}/attachments/${id}/finalize`,
    headers: headersFor(GM),
    payload: { size: body.size, checksum: body.checksum },
  });
  expect(finalized.statusCode).toBe(200);
  return { id, key: row.objectKey };
}

function offlineSet(harness: Harness, userId: string | undefined, campaignId = CAMPAIGN) {
  return harness.app.inject({
    method: 'GET',
    url: `/campaigns/${campaignId}/attachments/offline-estimate`,
    headers: headersFor(userId),
  });
}

function remove(
  harness: Harness,
  userId: string | undefined,
  id: string,
  expectedVersion: number | string = 1,
  headers: Record<string, string> = headersFor(userId),
) {
  return harness.app.inject({
    method: 'DELETE',
    url: `/campaigns/${CAMPAIGN}/attachments/${id}?expectedVersion=${expectedVersion}`,
    headers,
  });
}

function read(harness: Harness, userId: string, id: string) {
  return harness.app.inject({
    method: 'GET',
    url: `/campaigns/${CAMPAIGN}/attachments/${id}/read`,
    headers: headersFor(userId),
  });
}

function shape(response: Awaited<ReturnType<Harness['app']['inject']>>) {
  const { date: _date, ...headers } = response.headers;
  return { status: response.statusCode, body: response.body, headers };
}

describe('GET /campaigns/:campaignId/attachments/offline-estimate (task 05)', () => {
  // Scenario: Only currently visible attachments are pinned.
  test('returns only attachments the actor may read, with exact verified bytes, no-store', async () => {
    const harness = setup();
    const open = await attach(harness, { filename: 'map.png' });
    await attach(harness, { visibility: { mode: 'gm_only' }, filename: 'secret-villain.png' });
    await attach(harness, { owner: { resourceClass: 'fixture_note', resourceId: HIDDEN } });
    const response = await offlineSet(harness, CASEY);
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const body = response.json();
    expect(body.items.map((item: { attachmentId: string }) => item.attachmentId)).toEqual([
      open.id,
    ]);
    expect(body.totalBytes).toBe(PNG.byteLength);
    expect(response.body).not.toContain('secret-villain');
    expect(response.body).not.toContain(open.key);
    const gm = (await offlineSet(harness, GM)).json();
    expect(gm.items).toHaveLength(3);
    expect(gm.totalBytes).toBe(3 * PNG.byteLength);
  });

  test('outsiders, other campaigns and anonymous callers get the safe 404', async () => {
    const harness = setup();
    await attach(harness);
    const unmatched = shape(
      await harness.app.inject({
        method: 'GET',
        url: '/no-such-route',
        headers: headersFor(STRANGER),
      }),
    );
    expect(shape(await offlineSet(harness, STRANGER))).toEqual(unmatched);
    expect(shape(await offlineSet(harness, GM, OTHER_CAMPAIGN))).toEqual(unmatched);
    expect((await offlineSet(harness, undefined)).statusCode).toBe(401);
    // A member without read on any owner sees an empty set, never another member's files.
    expect((await offlineSet(harness, OBSERVER)).json() as unknown).toEqual({
      items: [],
      totalBytes: 0,
    });
  });
});

describe('DELETE /campaigns/:campaignId/attachments/:attachmentId (task 06)', () => {
  // Scenario: Deleting metadata does not remove the object inline.
  test('a GM tombstones the attachment; the object stays; reads, lists and the offline set drop it', async () => {
    const harness = setup();
    const { id, key } = await attach(harness);
    expect((await read(harness, CASEY, id)).statusCode).toBe(200);
    const response = await remove(harness, GM, id);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ attachmentId: id, version: 2 });
    expect(Object.keys(response.json()).sort()).toEqual(['attachmentId', 'deletedAt', 'version']);
    expect((harness.storage as MemoryObjectStorage).objects.has(key)).toBe(true);
    expect((await read(harness, CASEY, id)).statusCode).toBe(404);
    expect((await read(harness, GM, id)).statusCode).toBe(404);
    expect((await offlineSet(harness, GM)).json().items).toEqual([]);
    const deleted = harness.audit.filter((entry) => entry.event.action === 'attachment.deleted');
    expect(deleted).toHaveLength(1);
  });

  // Scenario: Repeating deletion is idempotent.
  test('a retried delete answers the same tombstone and keeps the deadline', async () => {
    const harness = setup();
    const { id } = await attach(harness);
    const first = await remove(harness, GM, id);
    const deadline = (harness.repository as MemoryAttachmentRepository).rows.get(id)?.purgeAfter;
    const again = await remove(harness, GM, id);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual(first.json());
    expect((harness.repository as MemoryAttachmentRepository).rows.get(id)?.purgeAfter).toEqual(
      deadline,
    );
  });

  test('a stale version conflicts; a malformed version is a validation error', async () => {
    const harness = setup();
    const { id } = await attach(harness);
    const stale = await remove(harness, GM, id, 7);
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe('version_conflict');
    expect((await remove(harness, GM, id, 'x')).statusCode).toBe(400);
    expect((await remove(harness, GM, id, 0)).statusCode).toBe(400);
  });

  // Deletion never leaks existence.
  test('hidden, missing, foreign and unauthorized deletes are byte-identical to an unknown attachment', async () => {
    const harness = setup();
    const open = await attach(harness);
    const gmOnly = await attach(harness, { visibility: { mode: 'gm_only' } });
    const missing = shape(await remove(harness, CASEY, '00000000-0000-4000-8000-00000000dead'));
    expect(missing.status).toBe(404);
    for (const [userId, id] of [
      [CASEY, open.id],
      [ROWAN, open.id],
      [CASEY, gmOnly.id],
      [STRANGER, open.id],
      [OBSERVER, open.id],
    ] as const) {
      expect(shape(await remove(harness, userId, id))).toEqual(missing);
    }
    expect((await read(harness, CASEY, open.id)).statusCode).toBe(200);
    expect(missing.body).not.toContain('harbor-map');
  });

  test('a cross-origin delete is refused before any decision', async () => {
    const harness = setup();
    const { id } = await attach(harness);
    const forged = await remove(harness, GM, id, 1, {
      ...headersFor(GM),
      origin: 'https://evil.invalid',
    });
    expect(forged.statusCode).toBe(403);
    expect((await read(harness, GM, id)).statusCode).toBe(200);
  });
});
