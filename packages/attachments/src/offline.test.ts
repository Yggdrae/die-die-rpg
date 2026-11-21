import { beforeEach, describe, expect, test } from 'bun:test';
import type { AttachmentMetadata } from './model.ts';
import {
  type DownloadResult,
  estimateTolerance,
  MemoryOfflineAttachmentDb,
  type OfflineAttachmentSource,
  OfflineAttachmentStore,
  type OfflineSetResult,
  type PinProgress,
  type ReadCheck,
} from './offline.ts';
import { CAMPAIGN, fileBytes, GM, NOTE, OTHER_CAMPAIGN, ownerId, sha256 } from './testing.ts';

/**
 * Feature 05 task 05: device-local store and campaign pinning (`_bdd.md`, Offline Availability)
 * over the in-memory record/byte store. The IndexedDB adapter and the real storage provider are
 * exercised in `apps/web/e2e/attachments-offline.e2e.ts`.
 */

const ID = (n: number) => `00000000-0000-4000-8000-${(0x7000 + n).toString(16).padStart(12, '0')}`;

function item(n: number, size = 300, campaignId = CAMPAIGN): AttachmentMetadata {
  const bytes = fileBytes('image/png', size);
  return {
    attachmentId: ID(n),
    campaignId,
    owner: { resourceClass: NOTE, resourceId: ownerId(1) },
    filename: `map-${n}.png`,
    mime: 'image/png',
    size,
    checksum: sha256(bytes),
    status: 'ready',
    visibility: { mode: 'everyone' },
    version: 1,
    createdAt: '2026-10-27T12:00:00.000Z',
    createdBy: GM,
    updatedAt: '2026-10-27T12:00:00.000Z',
    updatedBy: GM,
    finalizedAt: '2026-10-27T12:00:00.000Z',
  };
}

class FakeSource implements OfflineAttachmentSource {
  sets = new Map<string, OfflineSetResult>();
  bytes = new Map<string, Uint8Array>();
  denied = new Set<string>();
  checks = new Map<string, ReadCheck>();
  downloads: string[] = [];
  setRequests = 0;
  /** Downloads wait for `release()` while set. */
  hold = false;
  #waiting: (() => void)[] = [];
  network = true;
  maxParallel = 0;
  #parallel = 0;

  publish(campaignId: string, items: AttachmentMetadata[]) {
    this.sets.set(campaignId, { kind: 'ok', items });
    for (const entry of items) {
      if (!this.bytes.has(entry.attachmentId)) {
        this.bytes.set(entry.attachmentId, fileBytes(entry.mime, entry.size));
      }
    }
  }

  release() {
    for (const resolve of this.#waiting.splice(0)) resolve();
  }

  async offlineSet(campaignId: string): Promise<OfflineSetResult> {
    this.setRequests += 1;
    if (!this.network) return { kind: 'offline' };
    return this.sets.get(campaignId) ?? { kind: 'denied' };
  }

  async download(
    _campaignId: string,
    attachmentId: string,
    options: { signal: AbortSignal; onProgress: (bytes: number) => void },
  ): Promise<DownloadResult> {
    this.downloads.push(attachmentId);
    this.#parallel += 1;
    this.maxParallel = Math.max(this.maxParallel, this.#parallel);
    try {
      if (this.hold) await new Promise<void>((resolve) => this.#waiting.push(resolve));
      if (options.signal.aborted || !this.network) return { kind: 'failed' };
      if (this.denied.has(attachmentId)) return { kind: 'denied' };
      const bytes = this.bytes.get(attachmentId);
      if (bytes === undefined) return { kind: 'failed' };
      options.onProgress(Math.floor(bytes.byteLength / 2));
      options.onProgress(bytes.byteLength);
      return { kind: 'ok', bytes };
    } finally {
      this.#parallel -= 1;
    }
  }

  async check(_campaignId: string, attachmentId: string): Promise<ReadCheck> {
    if (!this.network) return 'offline';
    return this.checks.get(attachmentId) ?? 'allowed';
  }
}

let db: MemoryOfflineAttachmentDb;
let source: FakeSource;
let online: boolean;
let store: OfflineAttachmentStore;

function open(concurrency = 2) {
  store = new OfflineAttachmentStore({
    db,
    source,
    online: () => online,
    concurrency,
    now: () => new Date('2026-10-27T13:00:00.000Z'),
  });
  return store;
}

beforeEach(() => {
  db = new MemoryOfflineAttachmentDb();
  source = new FakeSource();
  online = true;
  open();
});

async function planned(campaignId = CAMPAIGN) {
  const result = await store.plan(campaignId);
  if (result.kind !== 'ok') throw new Error(result.kind);
  return result.plan;
}

describe('campaign pinning', () => {
  test('the estimate comes first and downloads nothing; dismissing leaves everything cloud only', async () => {
    source.publish(CAMPAIGN, [item(1, 300), item(2, 500)]);
    const plan = await planned();
    expect(plan.estimatedBytes).toBe(800);
    expect(plan.download.map((entry) => entry.attachmentId)).toEqual([ID(1), ID(2)]);
    expect(source.downloads).toEqual([]);
    // Dismissed: the device holds nothing, so nothing is listed or stored.
    expect(await store.list(CAMPAIGN)).toEqual([]);
    expect(db.blobs.size).toBe(0);
  });

  test('confirming reports progress per attachment and ends pinned with verified bytes', async () => {
    source.publish(CAMPAIGN, [item(1, 300), item(2, 500), item(3, 700)]);
    const plan = await planned();
    const updates: PinProgress[] = [];
    const final = await store.pin(plan, (progress) => updates.push(progress));
    expect(final).toMatchObject({ total: 3, completed: 3, failed: 0, done: true });
    expect(updates.some((update) => update.downloading.length > 0)).toBe(true);
    expect(updates.some((update) => update.downloadedBytes > 0 && !update.done)).toBe(true);
    expect(source.maxParallel).toBeLessThanOrEqual(2);
    const listed = await store.list(CAMPAIGN);
    expect(listed.map((entry) => entry.availability)).toEqual(['pinned', 'pinned', 'pinned']);
    expect(await store.usage(CAMPAIGN)).toEqual({ pinned: 1500, cached: 0 });
  });

  test('the estimate equals the verified payload stored, within max(1 MiB, 1%)', async () => {
    source.publish(CAMPAIGN, [item(1, 1_000), item(2, 250_000), item(3, 2_097_152)]);
    const plan = await planned();
    const final = await store.pin(plan);
    let actual = 0;
    for (const blob of db.blobs.values()) actual += blob.byteLength;
    expect(final.storedBytes).toBe(actual);
    expect(Math.abs(actual - plan.estimatedBytes)).toBeLessThanOrEqual(
      estimateTolerance(plan.estimatedBytes),
    );
    expect(actual).toBe(plan.estimatedBytes);
  });

  test('repeating campaign pinning makes no second copy and costs nothing more', async () => {
    source.publish(CAMPAIGN, [item(1), item(2)]);
    await store.pin(await planned());
    const downloads = source.downloads.length;
    const again = await planned();
    expect(again).toMatchObject({ estimatedBytes: 0, alreadyLocal: 2, download: [] });
    await store.pin(again);
    expect(source.downloads.length).toBe(downloads);
    expect(db.blobs.size).toBe(2);
    expect(await store.usage(CAMPAIGN)).toEqual({ pinned: 600, cached: 0 });
  });

  test('a cached copy with the same checksum is promoted to pinned without downloading', async () => {
    source.publish(CAMPAIGN, [item(1)]);
    expect(await store.cache(item(1))).toBe('cached');
    const downloads = source.downloads.length;
    const plan = await planned();
    expect(plan).toMatchObject({ estimatedBytes: 0, alreadyLocal: 1 });
    await store.pin(plan);
    expect(source.downloads.length).toBe(downloads);
    expect((await store.list(CAMPAIGN))[0]?.availability).toBe('pinned');
  });

  test('only attachments the authority returned are requested or stored', async () => {
    source.publish(CAMPAIGN, [item(1)]);
    source.bytes.set(ID(9), fileBytes('image/png', 300));
    await store.pin(await planned());
    expect(source.downloads).toEqual([ID(1)]);
    expect(await db.get(ID(9))).toBeUndefined();
    expect(db.blobs.has(ID(9))).toBe(false);
  });

  test('a corrupted or failed download stores nothing partial and keeps the pin intent', async () => {
    source.publish(CAMPAIGN, [item(1), item(2)]);
    source.bytes.set(ID(1), fileBytes('image/png', 299));
    source.bytes.set(ID(2), new Uint8Array(300));
    const final = await store.pin(await planned());
    expect(final).toMatchObject({ completed: 0, failed: 2 });
    expect(db.blobs.size).toBe(0);
    const listed = await store.list(CAMPAIGN);
    expect(listed.map((entry) => entry.availability)).toEqual(['cloud_only', 'cloud_only']);
    expect(listed.every((entry) => entry.pinRequestedAt !== undefined)).toBe(true);
    source.bytes.set(ID(1), fileBytes('image/png', 300));
    source.bytes.set(ID(2), fileBytes('image/png', 300));
    expect(await store.resume(CAMPAIGN)).toMatchObject({ completed: 2, failed: 0 });
  });

  test('an interrupted download resumes after restart without exposing partial bytes', async () => {
    source.publish(CAMPAIGN, [item(1)]);
    source.hold = true;
    // Never settles: the tab that started it is gone.
    void store.pin(await planned());
    await Bun.sleep(5);
    expect((await store.list(CAMPAIGN))[0]?.availability).toBe('downloading');
    // The tab closes mid-download: a new store over the same device data.
    const restarted = open();
    await restarted.start();
    const record = await db.get(ID(1));
    expect(record).toMatchObject({ state: 'cloud_only', downloadedBytes: 0 });
    expect(record?.pinRequestedAt).toBeDefined();
    expect(db.blobs.size).toBe(0);
    source.hold = false;
    expect(await restarted.resume(CAMPAIGN)).toMatchObject({ completed: 1 });
    expect((await restarted.list(CAMPAIGN))[0]?.availability).toBe('pinned');
  });
});

describe('opening local content', () => {
  test('a pinned attachment opens with no network request after restart', async () => {
    source.publish(CAMPAIGN, [item(1)]);
    await store.pin(await planned());
    online = false;
    source.network = false;
    const restarted = open();
    await restarted.start();
    const before = source.downloads.length + source.setRequests;
    const opened = await restarted.openLocal(ID(1));
    expect(opened.kind).toBe('local');
    if (opened.kind === 'local') {
      expect(opened.availability).toBe('pinned');
      expect(sha256(opened.bytes)).toBe(item(1).checksum);
    }
    expect(source.downloads.length + source.setRequests).toBe(before);
  });

  test('cached content opens offline and stays cached, not pinned', async () => {
    source.publish(CAMPAIGN, [item(1)]);
    await store.cache(item(1));
    online = false;
    const opened = await store.openLocal(ID(1));
    expect(opened.kind === 'local' && opened.availability).toBe('cached');
    expect((await store.list(CAMPAIGN))[0]?.availability).toBe('cached');
    expect(await store.usage(CAMPAIGN)).toEqual({ pinned: 0, cached: 300 });
  });

  test('missing local bytes degrade to unavailable offline and cloud only online', async () => {
    source.publish(CAMPAIGN, [item(1), item(2)]);
    source.bytes.set(ID(2), new Uint8Array(300));
    await store.pin(await planned());
    online = false;
    const listed = await store.list(CAMPAIGN);
    expect(
      Object.fromEntries(listed.map((entry) => [entry.attachmentId, entry.availability])),
    ).toEqual({
      [ID(1)]: 'pinned',
      [ID(2)]: 'unavailable',
    });
    expect(await store.openLocal(ID(2))).toEqual({ kind: 'unavailable' });
    online = true;
    expect(
      (await store.list(CAMPAIGN)).find((entry) => entry.attachmentId === ID(2))?.availability,
    ).toBe('cloud_only');
  });

  test('tampered local bytes fail checksum validation and are dropped', async () => {
    source.publish(CAMPAIGN, [item(1)]);
    await store.pin(await planned());
    db.blobs.set(ID(1), new Uint8Array(300));
    online = false;
    expect(await store.openLocal(ID(1))).toEqual({ kind: 'unavailable' });
    expect(db.blobs.has(ID(1))).toBe(false);
  });

  test('online, a denied read check removes the attachment instead of opening it', async () => {
    source.publish(CAMPAIGN, [item(1)]);
    await store.pin(await planned());
    source.checks.set(ID(1), 'denied');
    expect(await store.openLocal(ID(1))).toEqual({ kind: 'unavailable' });
    expect(await db.get(ID(1))).toBeUndefined();
    expect(db.blobs.has(ID(1))).toBe(false);
  });

  test('cache eviction drops least recently used cached bytes and never pinned bytes', async () => {
    source.publish(CAMPAIGN, [item(1), item(2), item(3)]);
    await store.pin({ ...(await planned()), items: [item(3)], download: [item(3)] });
    await store.cache(item(1));
    await store.cache(item(2));
    expect(await store.evict(300)).toBe(1);
    expect(await store.usage(CAMPAIGN)).toEqual({ pinned: 300, cached: 300 });
    expect(db.blobs.has(ID(3))).toBe(true);
  });
});

describe('removal signals', () => {
  test('visibility narrowing or deletion removes metadata and bytes on the next observed sync', async () => {
    source.publish(CAMPAIGN, [item(1), item(2)]);
    await store.pin(await planned());
    source.publish(CAMPAIGN, [item(2), item(3)]);
    expect(await store.reconcile(CAMPAIGN)).toBe('reconciled');
    expect(await db.get(ID(1))).toBeUndefined();
    expect(db.blobs.has(ID(1))).toBe(false);
    // A newly visible attachment becomes known as cloud only; nothing downloads by itself.
    expect(
      (await store.list(CAMPAIGN)).map((entry) => [entry.attachmentId, entry.availability]),
    ).toEqual([
      [ID(2), 'pinned'],
      [ID(3), 'cloud_only'],
    ]);
    expect(source.downloads.filter((id) => id === ID(3))).toEqual([]);
  });

  test('offline, reconciliation changes nothing (no remote erasure claim)', async () => {
    source.publish(CAMPAIGN, [item(1)]);
    await store.pin(await planned());
    source.network = false;
    expect(await store.reconcile(CAMPAIGN)).toBe('offline');
    expect(db.blobs.has(ID(1))).toBe(true);
  });

  test('membership revocation (replica purge or a denied set) removes everything and aborts downloads', async () => {
    source.publish(CAMPAIGN, [item(1), item(2)]);
    source.publish(OTHER_CAMPAIGN, [item(5, 300, OTHER_CAMPAIGN)]);
    await store.pin(await planned(OTHER_CAMPAIGN));
    source.hold = true;
    const pinning = store.pin(await planned());
    await Bun.sleep(5);
    await store.replicaPurged({
      campaignId: CAMPAIGN,
      replicaId: ID(99),
      reason: 'access_revoked',
      purgedAt: '2026-10-27T13:00:00Z',
    });
    source.hold = false;
    source.release();
    const final = await pinning;
    expect(final.completed).toBe(0);
    expect(await db.list(CAMPAIGN)).toEqual([]);
    expect(db.blobs.has(ID(1)) || db.blobs.has(ID(2))).toBe(false);
    // Another campaign is untouched.
    expect(db.blobs.has(ID(5))).toBe(true);
    source.sets.delete(OTHER_CAMPAIGN);
    expect(await store.reconcile(OTHER_CAMPAIGN)).toBe('purged');
    expect(db.records.size + db.blobs.size).toBe(0);
  });

  test('a denied download (hidden since the estimate) stores neither metadata nor bytes', async () => {
    source.publish(CAMPAIGN, [item(1), item(2)]);
    const plan = await planned();
    source.denied.add(ID(2));
    const final = await store.pin(plan);
    expect(final).toMatchObject({ completed: 1, failed: 1 });
    expect(await db.get(ID(2))).toBeUndefined();
  });

  test('sign-out clears every record and byte', async () => {
    source.publish(CAMPAIGN, [item(1)]);
    source.publish(OTHER_CAMPAIGN, [item(5, 300, OTHER_CAMPAIGN)]);
    await store.pin(await planned());
    await store.pin(await planned(OTHER_CAMPAIGN));
    await store.clear();
    expect(db.records.size + db.blobs.size).toBe(0);
  });
});
