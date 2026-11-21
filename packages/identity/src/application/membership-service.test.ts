import { describe, expect, mock, test } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import { MembershipCacheRow } from '../contracts/schemas.ts';
import type { MembershipRecord, MembershipStore } from './membership-service.ts';
import { MembershipService, toMembershipCacheRow } from './membership-service.ts';

const campaignId = '11111111-1111-1111-1111-111111111111';
const ownerId = '22222222-2222-2222-2222-222222222222';
const playerId = '33333333-3333-3333-3333-333333333333';
const gmId = '55555555-5555-5555-5555-555555555555';
const otherGmId = '66666666-6666-6666-6666-666666666666';
const assistantId = '77777777-7777-7777-7777-777777777777';
const now = new Date('2026-08-30T12:00:00Z');

function record(userId: string, role: MembershipRecord['role']): MembershipRecord {
  return {
    campaignId,
    userId,
    username: userId,
    role,
    version: 1,
    updatedAt: now,
    removedAt: null,
  };
}

function harness() {
  const records = new Map([
    [ownerId, record(ownerId, 'owner')],
    [playerId, record(playerId, 'player')],
    [gmId, record(gmId, 'gm')],
    [otherGmId, record(otherGmId, 'gm')],
    [assistantId, record(assistantId, 'assistant_gm')],
  ]);
  const store: MembershipStore = {
    find: async (_campaignId, userId) => records.get(userId),
    findWithin: async (_transaction, _campaignId, userId) => records.get(userId),
    listCampaign: async () => [...records.values()],
    listUser: async (userId) => [...records.values()].filter((item) => item.userId === userId),
    remove: async ({ targetUserId }) => {
      const current = records.get(targetUserId);
      if (current === undefined) return { ok: false, error: 'membership_not_found' };
      const changed = { ...current, removedAt: now, version: current.version + 1 };
      records.set(targetUserId, changed);
      return { ok: true, value: changed };
    },
    changeRole: async ({ targetUserId, role }) => {
      const current = records.get(targetUserId);
      if (current === undefined) return { ok: false, error: 'membership_not_found' };
      const changed = { ...current, role, version: current.version + 1 };
      records.set(targetUserId, changed);
      return { ok: true, value: changed };
    },
    transferOwnership: async ({ actorUserId, targetUserId }) => {
      const owner = records.get(actorUserId);
      const target = records.get(targetUserId);
      if (owner === undefined || target === undefined) {
        return { ok: false, error: 'owner_conflict' };
      }
      const formerOwner = { ...owner, role: 'gm' as const, version: owner.version + 1 };
      const newOwner = { ...target, role: 'owner' as const, version: target.version + 1 };
      records.set(actorUserId, formerOwner);
      records.set(targetUserId, newOwner);
      return { ok: true, value: { owner: newOwner, formerOwner } };
    },
  };
  const audit = mock(async (_event: unknown) => undefined);
  const publish = mock(async (_event: unknown) => undefined);
  const service = new MembershipService(
    store,
    { record: audit },
    { publish },
    { integrationDegraded: () => undefined },
  );
  return { service, audit, publish, records, store };
}

describe('MembershipService', () => {
  test('resolves only authoritative current membership', async () => {
    const { service } = harness();
    expect(await service.resolve(playerId, campaignId)).toEqual({
      ok: true,
      value: { userId: playerId, campaignId, role: 'player' },
    });
    expect(await service.resolve('44444444-4444-4444-4444-444444444444', campaignId)).toEqual({
      ok: false,
      error: 'membership_not_found',
    });
  });

  test('removal increments tombstone version and publishes after commit', async () => {
    const { service, audit, publish } = harness();
    expect(await service.remove(ownerId, campaignId, playerId)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(await service.resolve(playerId, campaignId)).toEqual({
      ok: false,
      error: 'membership_not_found',
    });
    expect(audit).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ userId: playerId, membershipVersion: 2, reason: 'removed' }),
    );
  });

  test('sole owner removal and non-owner administration fail closed', async () => {
    const { service } = harness();
    expect(await service.remove(ownerId, campaignId, ownerId)).toEqual({
      ok: false,
      error: 'owner_cannot_be_removed',
    });
    expect(await service.changeRole(playerId, campaignId, ownerId, 'gm')).toEqual({
      ok: false,
      error: 'not_found_or_forbidden',
    });
  });

  test.each([
    [ownerId, playerId, true],
    [ownerId, assistantId, true],
    [ownerId, gmId, true],
    [gmId, assistantId, true],
    [gmId, playerId, true],
    [gmId, otherGmId, false],
    [gmId, gmId, true],
    [assistantId, playerId, false],
    [playerId, assistantId, false],
  ] as const)('removal %#: actor %s target %s allowed=%s', async (actor, target, allowed) => {
    const { service, audit, publish, records } = harness();
    const before = records.get(target);
    const result = await service.remove(actor, campaignId, target);
    expect(result.ok).toBe(allowed);
    if (allowed) {
      expect((await service.resolve(target, campaignId)).ok).toBe(false);
      expect(audit).toHaveBeenCalledTimes(1);
      expect(publish).toHaveBeenCalledTimes(1);
    } else {
      expect(result).toEqual({ ok: false, error: 'not_found_or_forbidden' });
      expect(records.get(target)).toEqual(before);
      expect(audit).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
    }
  });

  test('gm self-removal leaves the owner unchanged', async () => {
    const { service, records } = harness();
    expect((await service.remove(gmId, campaignId, gmId)).ok).toBe(true);
    expect(records.get(ownerId)).toEqual(record(ownerId, 'owner'));
  });

  test('owner changes a non-owner role and the new role resolves immediately', async () => {
    const { service, audit, publish } = harness();
    const result = await service.changeRole(ownerId, campaignId, playerId, 'assistant_gm');
    expect(result).toMatchObject({ ok: true, value: { role: 'assistant_gm', version: 2 } });
    expect(await service.resolve(playerId, campaignId)).toEqual({
      ok: true,
      value: { userId: playerId, campaignId, role: 'assistant_gm' },
    });
    expect(audit).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ userId: playerId, membershipVersion: 2, reason: 'role_changed' }),
    );
  });

  test('non-owner role change, owner target, and observer/owner roles change nothing', async () => {
    const { service, publish, records } = harness();
    for (const actor of [gmId, assistantId, playerId]) {
      expect(await service.changeRole(actor, campaignId, playerId, 'gm')).toEqual({
        ok: false,
        error: 'not_found_or_forbidden',
      });
    }
    expect(await service.changeRole(ownerId, campaignId, ownerId, 'gm')).toEqual({
      ok: false,
      error: 'not_found_or_forbidden',
    });
    expect(await service.changeRole(ownerId, campaignId, playerId, 'observer')).toEqual({
      ok: false,
      error: 'invalid_role',
    });
    expect(await service.changeRole(ownerId, campaignId, playerId, 'owner')).toEqual({
      ok: false,
      error: 'invalid_role',
    });
    expect(records.get(playerId)?.role).toBe('player');
    expect(publish).not.toHaveBeenCalled();
  });

  test('ownership transfer is owner-only and publishes both changes after commit', async () => {
    const { service, audit, publish } = harness();
    expect(await service.transferOwnership(gmId, campaignId, playerId)).toEqual({
      ok: false,
      error: 'not_found_or_forbidden',
    });
    expect(publish).not.toHaveBeenCalled();
    const result = await service.transferOwnership(ownerId, campaignId, gmId);
    expect(result).toMatchObject({
      ok: true,
      value: { owner: { role: 'owner', version: 2 }, formerOwner: { role: 'gm', version: 2 } },
    });
    expect(audit).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(await service.resolve(ownerId, campaignId)).toMatchObject({
      ok: true,
      value: { role: 'gm' },
    });
  });

  test('audit or revocation failure never undoes a committed change', async () => {
    const { store } = harness();
    const degraded: unknown[] = [];
    const failing = new MembershipService(
      store,
      {
        record: async () => {
          throw new Error('audit down');
        },
      },
      {
        publish: async () => {
          throw new Error('sync down');
        },
      },
      { integrationDegraded: (...args) => void degraded.push(args) },
    );
    expect((await failing.remove(ownerId, campaignId, playerId)).ok).toBe(true);
    expect(degraded).toEqual([
      ['audit', campaignId, playerId, { event: 'membership.removed', membershipVersion: 2 }],
      ['revocation', campaignId, playerId, { event: 'removed', membershipVersion: 2 }],
    ]);
    expect((await failing.resolve(playerId, campaignId)).ok).toBe(false);
    expect(await failing.listCampaignIds(playerId)).toEqual([]);
    expect(await store.find(campaignId, playerId)).toMatchObject({ version: 2, removedAt: now });

    expect((await failing.changeRole(ownerId, campaignId, gmId, 'player')).ok).toBe(true);
    expect(await failing.resolve(gmId, campaignId)).toEqual({
      ok: true,
      value: { userId: gmId, campaignId, role: 'player' },
    });
    expect(degraded.slice(2)).toEqual([
      ['audit', campaignId, gmId, { event: 'membership.role_changed', membershipVersion: 2 }],
      ['revocation', campaignId, gmId, { event: 'role_changed', membershipVersion: 2 }],
    ]);
  });

  test('history fact resolves current and removed memberships without a role or name', async () => {
    const { service } = harness();
    expect(await service.historyFact(campaignId, playerId)).toEqual({
      campaignId,
      userId: playerId,
      version: 1,
      removed: false,
    });
    await service.remove(ownerId, campaignId, playerId);
    expect(await service.historyFact(campaignId, playerId)).toEqual({
      campaignId,
      userId: playerId,
      version: 2,
      removed: true,
    });
    expect(await service.historyFact(campaignId, '44444444-4444-4444-4444-444444444444')).toBe(
      undefined,
    );
  });

  test('cache mapping exposes only approved fields, tombstones included', async () => {
    const { service, store } = harness();
    await service.remove(ownerId, campaignId, playerId);
    const removed = await store.find(campaignId, playerId);
    if (removed === undefined) throw new Error('fixture missing');
    const row = toMembershipCacheRow(removed);
    expect(row).toEqual({
      campaignId,
      userId: playerId,
      role: 'player',
      version: 2,
      updatedAt: now.toISOString(),
      removedAt: now.toISOString(),
    });
    expect(Value.Check(MembershipCacheRow, row)).toBe(true);
    expect(Value.Check(MembershipCacheRow, { ...row, username: 'player' })).toBe(false);
    expect(Value.Check(MembershipCacheRow, { ...row, role: 'observer' })).toBe(false);
  });

  test('lists hide tombstones and a malformed cursor yields an empty page', async () => {
    const { service } = harness();
    await service.remove(ownerId, campaignId, playerId);
    expect(await service.listCampaign(playerId, campaignId, {})).toEqual({
      ok: false,
      error: 'not_found_or_forbidden',
    });
    expect(await service.listCampaign(ownerId, campaignId, { cursor: 'not-a-cursor' })).toEqual({
      ok: true,
      value: { items: [] },
    });
    expect(await service.listUser(ownerId, { cursor: 'x' })).toEqual({ items: [] });
  });
});
