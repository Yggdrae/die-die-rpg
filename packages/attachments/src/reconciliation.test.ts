import { beforeEach, describe, expect, test } from 'bun:test';
import type { TombstonePurgeDecision } from '@rpg/contracts';
import type { NewPendingAttachment } from './application.ts';
import { AttachmentCleanup } from './cleanup.ts';
import { objectKeyFor } from './content.ts';
import { MemoryAttachmentRepository, MemoryObjectStorage } from './memory.ts';
import { DELETED_RETENTION_DAYS } from './policy.ts';
import {
  AttachmentReconciler,
  type AttachmentReconcilerDependencies,
  NO_RETAINED_ATTACHMENT_REFERENCES,
} from './reconciliation.ts';
import { fileBytes, GM, NOTE, ownerId, sha256 } from './testing.ts';

/**
 * Feature 05 task 06: retention and reconciliation (`_bdd.md`, A retained object is eventually
 * removed; Deleting metadata does not remove the object inline; `_db.md`, Deletion and
 * Reconciliation) over the in-memory kit. The PostgreSQL boundaries are in
 * `infra/postgres/retention.integration.test.ts`.
 */

const DAY = 86_400_000;
const CAMPAIGN_A = '00000000-0000-4000-8000-00000000aa01';
const CAMPAIGN_B = '00000000-0000-4000-8000-00000000aa02';

let clock: Date;
let repository: MemoryAttachmentRepository;
let storage: MemoryObjectStorage;
let deletedCampaigns: Set<string>;

beforeEach(() => {
  clock = new Date('2026-10-27T12:00:00.000Z');
  repository = new MemoryAttachmentRepository(() => clock);
  storage = new MemoryObjectStorage(() => clock);
  deletedCampaigns = new Set();
});

function reconciler(overrides: Partial<AttachmentReconcilerDependencies> = {}) {
  return new AttachmentReconciler({
    repository,
    storage,
    campaigns: { isDeleted: async (campaignId) => deletedCampaigns.has(campaignId) },
    references: NO_RETAINED_ATTACHMENT_REFERENCES,
    now: () => clock,
    ...overrides,
  });
}

async function ready(campaignId = CAMPAIGN_A) {
  const id = crypto.randomUUID();
  const bytes = fileBytes('image/png');
  const input: NewPendingAttachment = {
    id,
    campaignId,
    ownerResourceClass: NOTE,
    ownerResourceId: ownerId(1),
    filename: 'map.png',
    mime: 'image/png',
    declaredSize: bytes.byteLength,
    declaredChecksum: sha256(bytes),
    objectKey: objectKeyFor(campaignId, id),
    visibility: { mode: 'everyone' },
    createdBy: GM,
  };
  await repository.insertPending(input);
  await repository.markReady(campaignId, id, {
    size: bytes.byteLength,
    checksum: input.declaredChecksum,
    actorUserId: GM,
  });
  storage.put(input.objectKey, bytes);
  return { id, key: input.objectKey };
}

async function deleteNow(campaignId: string, id: string) {
  const row = await repository.find(campaignId, id);
  if (row === undefined) throw new Error('missing');
  await repository.markDeleted(campaignId, id, { expectedVersion: row.version, actorUserId: GM });
}

describe('retention purge', () => {
  test('the object stays for the whole retention window, then object and tombstone go', async () => {
    const attached = await ready();
    await deleteNow(CAMPAIGN_A, attached.id);
    clock = new Date(clock.getTime() + DELETED_RETENTION_DAYS * DAY);
    // Exactly at the deadline: not yet due (exclusive boundary).
    expect((await reconciler().run()).purged).toBe(0);
    expect(storage.objects.has(attached.key)).toBe(true);
    clock = new Date(clock.getTime() + 1);
    const report = await reconciler().run();
    expect(report.purged).toBe(1);
    expect(storage.objects.has(attached.key)).toBe(false);
    expect(await repository.find(CAMPAIGN_A, attached.id)).toBeUndefined();
    // A later pass restores nothing and finds nothing to do.
    expect(await reconciler().run()).toEqual({
      deletedCampaigns: 0,
      tombstoned: 0,
      purged: 0,
      retainedByReference: 0,
      retainedByWatermark: 0,
      storageFailures: 0,
    });
    expect(await repository.find(CAMPAIGN_A, attached.id)).toBeUndefined();
  });

  test('a live attachment is never purged', async () => {
    const attached = await ready();
    clock = new Date(clock.getTime() + 400 * DAY);
    await reconciler().run();
    expect(storage.objects.has(attached.key)).toBe(true);
    expect((await repository.find(CAMPAIGN_A, attached.id))?.status).toBe('ready');
  });

  test('a retained export/import reference holds both the object and the tombstone', async () => {
    const attached = await ready();
    await deleteNow(CAMPAIGN_A, attached.id);
    clock = new Date(clock.getTime() + 31 * DAY);
    const held = new Set<string>([attached.id]);
    const report = await reconciler({
      references: {
        referenced: async (rows) => new Set(rows.map((row) => row.id).filter((id) => held.has(id))),
      },
    }).run();
    expect(report).toMatchObject({ purged: 0, retainedByReference: 1 });
    expect(storage.objects.has(attached.key)).toBe(true);
    held.clear();
    expect((await reconciler().run()).purged).toBe(1);
  });

  test('replicated metadata waits for the feature 03 watermark; missing evidence is never permission', async () => {
    const attached = await ready();
    await deleteNow(CAMPAIGN_A, attached.id);
    clock = new Date(clock.getTime() + 31 * DAY);
    let decision: TombstonePurgeDecision = { safe: false, blockers: ['unacknowledged_replica'] };
    const asked: unknown[] = [];
    const evidence = {
      decide: async (tombstone: unknown) => {
        asked.push(tombstone);
        return decision;
      },
    };
    expect((await reconciler({ syncTombstones: evidence }).run()).retainedByWatermark).toBe(1);
    expect(asked[0]).toMatchObject({ campaignId: CAMPAIGN_A, scope: 'attachments', sequence: 2 });
    const failing = {
      decide: async (): Promise<TombstonePurgeDecision> => {
        throw new Error('evidence_unavailable');
      },
    };
    expect((await reconciler({ syncTombstones: failing }).run()).retainedByWatermark).toBe(1);
    expect(storage.objects.has(attached.key)).toBe(true);
    decision = { safe: true };
    expect((await reconciler({ syncTombstones: evidence }).run()).purged).toBe(1);
  });

  test('a provider failure keeps the tombstone for the next pass; a missing object converges', async () => {
    const failing = await ready();
    const vanished = await ready();
    await deleteNow(CAMPAIGN_A, failing.id);
    await deleteNow(CAMPAIGN_A, vanished.id);
    storage.objects.delete(vanished.key);
    clock = new Date(clock.getTime() + 31 * DAY);
    storage.failing.add('delete');
    const first = await reconciler().run();
    expect(first).toMatchObject({ purged: 0, storageFailures: 2 });
    expect(await repository.find(CAMPAIGN_A, failing.id)).toBeDefined();
    storage.failing.delete('delete');
    const second = await reconciler().run();
    expect(second).toMatchObject({ purged: 2, storageFailures: 0 });
    expect(repository.rows.size).toBe(0);
  });
});

describe('campaign deletion', () => {
  test('every live attachment of a deleted campaign is tombstoned under the same 30-day rule, once', async () => {
    const first = await ready(CAMPAIGN_A);
    const second = await ready(CAMPAIGN_A);
    const other = await ready(CAMPAIGN_B);
    deletedCampaigns.add(CAMPAIGN_A);
    const report = await reconciler().run();
    expect(report).toMatchObject({ deletedCampaigns: 1, tombstoned: 2, purged: 0 });
    for (const id of [first.id, second.id]) {
      const row = await repository.find(CAMPAIGN_A, id);
      expect(row?.deletedAt?.getTime()).toBe(clock.getTime());
      expect(row?.purgeAfter?.getTime()).toBe(clock.getTime() + DELETED_RETENTION_DAYS * DAY);
    }
    expect((await repository.find(CAMPAIGN_B, other.id))?.deletedAt).toBeUndefined();
    expect(storage.objects.has(first.key)).toBe(true);
    const deadline = (await repository.find(CAMPAIGN_A, first.id))?.purgeAfter?.getTime();
    clock = new Date(clock.getTime() + DAY);
    expect((await reconciler().run()).tombstoned).toBe(0);
    expect((await repository.find(CAMPAIGN_A, first.id))?.purgeAfter?.getTime()).toBe(
      deadline ?? Number.NaN,
    );
    clock = new Date(clock.getTime() + 30 * DAY);
    expect((await reconciler().run()).purged).toBe(2);
    expect(storage.objects.has(other.key)).toBe(true);
  });
});

describe('diagnostics', () => {
  test('orphan and missing objects are reported, never deleted or restored', async () => {
    const healthy = await ready();
    const missing = await ready();
    storage.objects.delete(missing.key);
    const orphanId = crypto.randomUUID();
    const orphanKey = objectKeyFor(CAMPAIGN_B, orphanId);
    storage.put(orphanKey, fileBytes('image/png'));
    storage.put('campaigns/not-an-attachment-key', new Uint8Array(1));
    const diagnosis = await reconciler().diagnose({ pageSize: 2 });
    expect(diagnosis).toEqual({
      orphanObjects: [{ campaignId: CAMPAIGN_B, attachmentId: orphanId }],
      foreignObjects: 1,
      missingObjects: [missing.id],
      scannedObjects: 3,
      scannedRows: 2,
      complete: true,
    });
    expect(JSON.stringify(diagnosis)).not.toContain(orphanKey);
    expect(storage.objects.has(orphanKey)).toBe(true);
    expect(storage.deleted).toEqual([]);
    expect((await repository.find(CAMPAIGN_A, missing.id))?.status).toBe('ready');
    expect((await repository.find(CAMPAIGN_A, healthy.id))?.status).toBe('ready');
    const partial = await reconciler().diagnose({ pageSize: 1, maxPages: 1 });
    expect(partial.complete).toBe(false);
  });
});

describe('cleanup backlog (task 07)', () => {
  test('a backlog larger than one pass drains over several passes without touching ready rows', async () => {
    const kept = await ready();
    for (let index = 0; index < 250; index += 1) {
      const id = crypto.randomUUID();
      const key = objectKeyFor(CAMPAIGN_A, id);
      const bytes = fileBytes('image/png');
      await repository.insertPending({
        id,
        campaignId: CAMPAIGN_A,
        ownerResourceClass: NOTE,
        ownerResourceId: ownerId(1),
        filename: 'abandoned.png',
        mime: 'image/png',
        declaredSize: bytes.byteLength,
        declaredChecksum: sha256(bytes),
        objectKey: key,
        visibility: { mode: 'everyone' },
        createdBy: GM,
      });
      storage.put(key, bytes);
    }
    clock = new Date(clock.getTime() + 8 * DAY);
    const cleanup = new AttachmentCleanup({ repository, storage, batchSize: 100 });
    const passes: number[] = [];
    for (let pass = 0; pass < 6 && repository.rows.size > 1; pass += 1) {
      const report = await cleanup.run();
      passes.push(report.expired + report.purged);
    }
    expect(repository.rows.size).toBe(1);
    expect(storage.objects.size).toBe(1);
    expect(storage.objects.has(kept.key)).toBe(true);
    expect(passes.length).toBeGreaterThan(1);
  });
});
