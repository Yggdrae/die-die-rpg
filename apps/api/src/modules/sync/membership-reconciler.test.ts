import { describe, expect, test } from 'bun:test';
import type { ReplicaPurged } from '@rpg/contracts';
import { makeEntity } from '@rpg/contracts/testing/repository-contract';
import {
  type MembershipRecord,
  reconcileMembershipCache,
  toMembershipCacheRow,
} from '@rpg/identity';
import { SyncStatusStore } from '@rpg/sync';
import {
  ConflictHub,
  ReplicaAccessReconciler,
  ReplicaManager,
  SqliteReplicaStore,
  SqliteSyncedRepository,
} from '@rpg/sync/bun';

/**
 * Feature 01 task 12 (criterion 3): the device-side reconciler driven by identity's own
 * `reconcileMembershipCache` rule and `toMembershipCacheRow` mapping, as production wires them.
 * A higher server version replaces the cached role; a tombstone removes cached access, purges
 * the replica, and a stale lower version cannot restore it.
 */

// `makeEntity` writes into this campaign.
const CAMPAIGN = '3f2504e0-4f89-41d3-9a0c-0305e82c3300';
const USER = '3f2504e0-4f89-41d3-9a0c-0305e82c3390';
const at = new Date('2026-10-25T10:00:00Z');

function server(overrides: Partial<MembershipRecord> = {}): MembershipRecord {
  return {
    campaignId: CAMPAIGN,
    userId: USER,
    username: 'never-cached',
    role: 'gm',
    version: 1,
    updatedAt: at,
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
  const access = new ReplicaAccessReconciler(store, replicas, reconcileMembershipCache);
  const apply = (record: MembershipRecord, complete = true) =>
    access.applyMemberships(USER, [toMembershipCacheRow(record)], { complete });
  return { store, purged, repository, access, apply };
}

describe('device reconciler with identity membership rules', () => {
  test('higher server version replaces the cached role; equal or lower is kept', async () => {
    const local = device();
    await local.apply(server());
    expect(local.access.actor(USER, CAMPAIGN)?.role).toBe('gm');
    expect((await local.apply(server({ role: 'player', version: 2 }))).replaced).toEqual([
      CAMPAIGN,
    ]);
    expect(local.access.actor(USER, CAMPAIGN)?.role).toBe('player');
    expect((await local.apply(server({ role: 'owner', version: 2 }))).kept).toEqual([CAMPAIGN]);
    expect((await local.apply(server({ role: 'owner', version: 1 }))).kept).toEqual([CAMPAIGN]);
    expect(local.access.actor(USER, CAMPAIGN)?.role).toBe('player');
  });

  test('tombstone purges the replica and pending work; stale versions never restore access', async () => {
    const local = device();
    await local.apply(server());
    await local.repository.upsert(makeEntity(crypto.randomUUID(), 'Secret plans'), null);
    expect(local.store.pendingCount(CAMPAIGN)).toBe(1);

    const report = await local.apply(server({ version: 2, removedAt: at }));
    expect(report.removed).toEqual([CAMPAIGN]);
    expect(local.purged).toEqual([
      expect.objectContaining({ campaignId: CAMPAIGN, reason: 'access_revoked' }),
    ]);
    expect(local.store.list('entities', CAMPAIGN, { includeDeleted: true })).toHaveLength(0);
    expect(local.store.pendingCount()).toBe(0);
    expect(local.access.actor(USER, CAMPAIGN)).toBeUndefined();
    expect((await local.repository.upsert(makeEntity(crypto.randomUUID(), 'Late'), null)).ok).toBe(
      false,
    );

    await local.apply(server({ version: 1 }), false);
    await local.apply(server({ version: 2 }), false);
    expect(local.access.actor(USER, CAMPAIGN)).toBeUndefined();
    // Rejoin is a higher version.
    await local.apply(server({ version: 3, role: 'player' }), false);
    expect(local.access.actor(USER, CAMPAIGN)?.role).toBe('player');
  });

  test('only approved cache fields reach the device', async () => {
    const local = device();
    await local.apply(server());
    expect(Object.keys(toMembershipCacheRow(server())).sort()).toEqual([
      'campaignId',
      'removedAt',
      'role',
      'updatedAt',
      'userId',
      'version',
    ]);
    expect(JSON.stringify(local.store.cachedMembership(CAMPAIGN))).not.toContain('never-cached');
  });
});
