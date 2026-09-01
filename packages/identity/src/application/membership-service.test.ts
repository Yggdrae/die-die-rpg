import { describe, expect, mock, test } from 'bun:test';
import type { MembershipRecord, MembershipStore } from './membership-service.ts';
import { MembershipService } from './membership-service.ts';

const campaignId = '11111111-1111-1111-1111-111111111111';
const ownerId = '22222222-2222-2222-2222-222222222222';
const playerId = '33333333-3333-3333-3333-333333333333';
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
  ]);
  const store: MembershipStore = {
    find: async (_campaignId, userId) => records.get(userId),
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
    transferOwnership: async () => ({ ok: false, error: 'owner_conflict' }),
  };
  const audit = mock(async () => undefined);
  const publish = mock(async () => undefined);
  const service = new MembershipService(
    store,
    { record: audit },
    { publish },
    { integrationDegraded: () => undefined },
  );
  return { service, audit, publish };
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
});
