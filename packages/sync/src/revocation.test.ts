import { describe, expect, test } from 'bun:test';
import type {
  CampaignAccessRevoked,
  ReplicaPurged,
  TombstonePurgeEvidence,
  TombstoneRef,
} from '@rpg/contracts';
import { makeEntity } from '@rpg/contracts/testing/repository-contract';
import { ConflictHub, ReplicaManager, SqliteSyncedRepository } from './bun-repository.ts';
import { SqliteReplicaStore } from './bun-sqlite.ts';
import type { CachedMembership, MembershipReconcile } from './model.ts';
import { ReplicaAccessReconciler } from './replica-access.ts';
import {
  DurableRevocationPublisher,
  InMemoryRevocationDeliveryOutbox,
  type RevocationDelivery,
} from './revocation-delivery.ts';
import { SyncStatusStore } from './status.ts';
import { reportTombstonePurge } from './watermarks.ts';

// `makeEntity` writes into this campaign.
const CAMPAIGN = '3f2504e0-4f89-41d3-9a0c-0305e82c3300';
const OTHER_CAMPAIGN = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const USER = '3f2504e0-4f89-41d3-9a0c-0305e82c3390';
const STRANGER = '3f2504e0-4f89-41d3-9a0c-0305e82c3399';

/** Same rule shape as feature 01's `reconcileMembershipCache` (injected in production). */
const reconcile: MembershipReconcile = (cached, incoming) => {
  if (cached !== undefined && incoming.version <= cached.version) return 'keep';
  return incoming.removedAt === null ? 'replace' : 'remove';
};

function membership(overrides: Partial<CachedMembership> = {}): CachedMembership {
  return {
    campaignId: CAMPAIGN,
    userId: USER,
    role: 'gm',
    version: 1,
    updatedAt: '2026-10-24T10:00:00Z',
    removedAt: null,
    ...overrides,
  };
}

function device() {
  const store = new SqliteReplicaStore();
  const status = new SyncStatusStore();
  const purged: ReplicaPurged[] = [];
  const replicas = new ReplicaManager(store, status, [
    { replicaPurged: async (event) => void purged.push(event) },
  ]);
  const repository = new SqliteSyncedRepository(
    store,
    'entities',
    'entities',
    { userId: USER, campaignId: CAMPAIGN, role: 'gm' },
    status,
    new ConflictHub(),
  );
  return {
    store,
    status,
    purged,
    replicas,
    repository,
    access: new ReplicaAccessReconciler(store, replicas, reconcile),
  };
}

describe('device access reconciliation', () => {
  test('higher version replaces the cached role; stale delivery is kept', async () => {
    const local = device();
    await local.access.applyMemberships(USER, [membership()], { complete: false });
    expect(local.access.actor(USER, CAMPAIGN)).toEqual({
      userId: USER,
      campaignId: CAMPAIGN,
      role: 'gm',
    });
    const report = await local.access.applyMemberships(
      USER,
      [membership({ role: 'player', version: 2 })],
      { complete: false },
    );
    expect(report.replaced).toEqual([CAMPAIGN]);
    expect(local.access.actor(USER, CAMPAIGN)?.role).toBe('player');
    const stale = await local.access.applyMemberships(
      USER,
      [membership({ role: 'owner', version: 1 })],
      { complete: false },
    );
    expect(stale.kept).toEqual([CAMPAIGN]);
    expect(local.access.actor(USER, CAMPAIGN)?.role).toBe('player');
  });

  test('tombstone on reconnect drops campaign data and pending work and emits ReplicaPurged', async () => {
    const local = device();
    await local.access.applyMemberships(USER, [membership()], { complete: true });
    await local.repository.upsert(makeEntity(crypto.randomUUID(), 'Secret plans'), null);
    expect(local.store.pendingCount(CAMPAIGN)).toBe(1);
    const replicaId = local.store.replicaId(CAMPAIGN);

    const report = await local.access.applyMemberships(
      USER,
      [membership({ version: 2, removedAt: '2026-10-24T11:00:00Z' })],
      { complete: true },
    );

    expect(report.removed).toEqual([CAMPAIGN]);
    expect(local.store.list('entities', CAMPAIGN, { includeDeleted: true })).toHaveLength(0);
    expect(local.store.pending(CAMPAIGN)).toEqual([]);
    expect(local.store.pendingCount()).toBe(0);
    expect(local.status.snapshot().pendingCount).toBe(0);
    expect(local.purged).toEqual([
      { campaignId: CAMPAIGN, replicaId, reason: 'access_revoked', purgedAt: expect.any(String) },
    ]);
    expect(local.access.actor(USER, CAMPAIGN)).toBeUndefined();
    // Queued writes are refused after revocation; a stale lower version cannot restore access.
    const refused = await local.repository.upsert(makeEntity(crypto.randomUUID(), 'Late'), null);
    expect(refused.ok).toBe(false);
    await local.access.applyMemberships(USER, [membership({ version: 1 })], { complete: false });
    expect(local.access.actor(USER, CAMPAIGN)).toBeUndefined();
    // Rejoin is a higher version and restores access.
    await local.access.applyMemberships(USER, [membership({ version: 3, role: 'player' })], {
      complete: false,
    });
    expect(local.access.actor(USER, CAMPAIGN)?.role).toBe('player');
  });

  test('absence from a complete set revokes only authority-confirmed campaigns', async () => {
    const local = device();
    await local.access.applyMemberships(USER, [membership()], { complete: true });
    await local.repository.upsert(makeEntity(crypto.randomUUID(), 'Cached'), null);
    // Offline-created campaign: queued create, no cached membership yet.
    const offline = new SqliteSyncedRepository(
      local.store,
      'campaigns',
      'campaigns',
      { userId: USER, campaignId: OTHER_CAMPAIGN, role: 'owner' },
      local.status,
      new ConflictHub(),
    );
    await offline.upsert(
      { ...makeEntity(OTHER_CAMPAIGN, 'Offline campaign'), campaignId: OTHER_CAMPAIGN },
      null,
    );

    const report = await local.access.applyMemberships(USER, [], { complete: true });

    expect(report.removed).toEqual([CAMPAIGN]);
    expect(local.store.list('entities', CAMPAIGN, {})).toHaveLength(0);
    expect(local.store.pendingCount(OTHER_CAMPAIGN)).toBe(1);
    expect(await local.access.accessDenied(OTHER_CAMPAIGN)).toBeUndefined();
    expect(local.store.pendingCount(OTHER_CAMPAIGN)).toBe(1);
    expect((await local.repository.upsert(makeEntity(crypto.randomUUID(), 'x'), null)).ok).toBe(
      false,
    );
  });

  test('a foreign user row is never cached', async () => {
    const local = device();
    const report = await local.access.applyMemberships(
      USER,
      [membership({ userId: STRANGER, role: 'owner' })],
      { complete: false },
    );
    expect(report).toMatchObject({ replaced: [], removed: [], kept: [] });
    expect(local.store.cachedMemberships()).toEqual([]);
  });

  test('confirmed campaign deletion and sign-out clean up locally', async () => {
    const local = device();
    await local.access.applyMemberships(
      USER,
      [membership(), membership({ campaignId: OTHER_CAMPAIGN })],
      { complete: true },
    );
    await local.repository.upsert(makeEntity(crypto.randomUUID(), 'Deleted campaign data'), null);
    const deleted = await local.access.campaignDeleted(CAMPAIGN);
    expect(deleted.event.reason).toBe('campaign_deleted');
    expect(local.store.list('entities', CAMPAIGN, { includeDeleted: true })).toHaveLength(0);
    expect(local.store.pendingCount(CAMPAIGN)).toBe(0);
    expect(local.store.cachedMembership(CAMPAIGN)).toBeUndefined();

    const signedOut = await local.replicas.signOut();
    expect(signedOut.map((result) => result.event)).toEqual([
      expect.objectContaining({ campaignId: OTHER_CAMPAIGN, reason: 'signed_out' }),
    ]);
    expect(local.store.cachedMemberships()).toEqual([]);
    expect(local.store.campaignIds()).toEqual([]);
    expect(local.status.snapshot()).toMatchObject({ connected: false, pendingCount: 0 });
  });

  test('a failing purge listener never undoes the purge', async () => {
    const store = new SqliteReplicaStore();
    const status = new SyncStatusStore();
    const manager = new ReplicaManager(store, status, [
      {
        replicaPurged: async () => {
          throw new Error('attachment store down');
        },
      },
    ]);
    store.putMembership(membership());
    const result = await manager.revoke(CAMPAIGN);
    expect(result.listenerErrors).toHaveLength(1);
    expect(store.campaignIds()).toEqual([CAMPAIGN]);
    expect(store.accessRevoked(CAMPAIGN)).toBe(true);
    expect(store.list('entities', CAMPAIGN, {})).toHaveLength(0);
  });

  test('watermark evidence lists records still referenced by unfinished local work', async () => {
    const local = device();
    const record = makeEntity(crypto.randomUUID(), 'Pending');
    await local.repository.upsert(record, null);
    expect(local.store.pendingRecordIds(CAMPAIGN, 'entities')).toEqual([record.id]);
    expect(local.store.pendingRecordIds(CAMPAIGN, 'campaigns')).toEqual([]);
  });
});

const EVENT: CampaignAccessRevoked = {
  campaignId: CAMPAIGN,
  userId: USER,
  membershipVersion: 4,
  reason: 'removed',
  committedAt: '2026-10-24T10:00:00Z',
};

describe('durable revocation delivery', () => {
  test('degraded delivery is recorded, observable, retried, and never thrown to the caller', async () => {
    const outbox = new InMemoryRevocationDeliveryOutbox();
    let now = new Date('2026-10-24T10:00:00Z');
    let healthy = false;
    const invalidated: CampaignAccessRevoked[] = [];
    const retrying: { delivery: RevocationDelivery; code: string }[] = [];
    const publisher = new DurableRevocationPublisher(
      outbox,
      [
        {
          invalidate: async (event) => {
            if (!healthy) throw Object.assign(new Error('select secret'), { code: 'ECONNREFUSED' });
            invalidated.push(event);
          },
        },
      ],
      {
        deliveryRetrying: (delivery, code) => retrying.push({ delivery, code }),
        deliveryFailed: () => undefined,
      },
      { baseBackoffMs: 1_000, clock: () => now },
    );

    await publisher.publish(EVENT);
    expect(await publisher.backlog()).toEqual({
      pending: 1,
      failed: 0,
      oldestPendingAt: EVENT.committedAt,
    });
    expect(retrying).toEqual([
      { delivery: expect.objectContaining({ attemptCount: 1 }), code: 'ECONNREFUSED' },
    ]);
    expect(outbox.list()[0]).toMatchObject({ lastErrorCode: 'ECONNREFUSED', attemptCount: 1 });

    // Not yet due: nothing happens.
    expect(await publisher.retryDue()).toEqual({ delivered: 0, retrying: 0, failed: 0 });
    healthy = true;
    now = new Date('2026-10-24T10:00:02Z');
    expect(await publisher.retryDue()).toEqual({ delivered: 1, retrying: 0, failed: 0 });
    expect(invalidated).toEqual([EVENT]);
    expect(await publisher.backlog()).toEqual({ pending: 0, failed: 0 });

    // Duplicate publish of the same committed fact is idempotent.
    await publisher.publish(EVENT);
    expect(invalidated).toHaveLength(1);
    expect(outbox.list()).toHaveLength(1);
  });

  test('exhausted retries end in an observable failed state', async () => {
    const outbox = new InMemoryRevocationDeliveryOutbox();
    const failed: string[] = [];
    let now = new Date('2026-10-24T10:00:00Z');
    const publisher = new DurableRevocationPublisher(
      outbox,
      [
        {
          invalidate: async () => {
            throw new Error('down');
          },
        },
      ],
      {
        deliveryRetrying: () => undefined,
        deliveryFailed: (delivery, code) => failed.push(`${delivery.deliveryId}:${code}`),
      },
      { maxAttempts: 2, baseBackoffMs: 10, clock: () => now },
    );
    await publisher.publish(EVENT);
    now = new Date('2026-10-24T10:01:00Z');
    expect(await publisher.retryDue()).toEqual({ delivered: 0, retrying: 0, failed: 1 });
    expect(failed).toEqual([expect.stringMatching(/:delivery_error$/)]);
    expect(await publisher.backlog()).toMatchObject({ pending: 0, failed: 1 });
  });

  test('an outbox write failure propagates so feature 01 logs integrationDegraded', async () => {
    const outbox = new InMemoryRevocationDeliveryOutbox();
    outbox.enqueue = async () => {
      throw new Error('database down');
    };
    const publisher = new DurableRevocationPublisher(outbox, [], {
      deliveryRetrying: () => undefined,
      deliveryFailed: () => undefined,
    });
    let thrown: unknown;
    try {
      await publisher.publish(EVENT);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
  });
});

describe('report-only tombstone purge', () => {
  test('classifies candidates and deletes nothing', async () => {
    const tombstone = (recordId: string): TombstoneRef => ({
      campaignId: CAMPAIGN,
      scope: 'campaigns',
      recordId,
      sequence: 3,
      deletedAt: '2026-01-01T00:00:00Z',
    });
    const safe = tombstone('3f2504e0-4f89-41d3-9a0c-0305e82c3310');
    const held = tombstone('3f2504e0-4f89-41d3-9a0c-0305e82c3311');
    const evidence: TombstonePurgeEvidence = {
      acknowledge: async () => undefined,
      decide: async (candidate) =>
        candidate.recordId === safe.recordId
          ? { safe: true }
          : { safe: false, blockers: ['unacknowledged_replica'] },
    };
    expect(await reportTombstonePurge(evidence, [safe, held], new Date())).toEqual({
      purgeable: [safe],
      retained: [{ tombstone: held, blockers: ['unacknowledged_replica'] }],
    });
  });
});
