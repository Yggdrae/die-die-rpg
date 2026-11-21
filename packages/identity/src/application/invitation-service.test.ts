import { describe, expect, mock, test } from 'bun:test';
import type { InvitationRecord, InvitationStore } from './invitation-service.ts';
import { InvitationService } from './invitation-service.ts';

const campaignId = '11111111-1111-1111-1111-111111111111';
const userId = '22222222-2222-2222-2222-222222222222';
const quietLog = { integrationDegraded: () => undefined };

class FakeInvitationStore implements InvitationStore {
  record?: InvitationRecord;
  digest?: Uint8Array;

  async issue(input: Parameters<InvitationStore['issue']>[0]) {
    this.digest = input.tokenDigest;
    this.record = {
      id: input.id,
      campaignId,
      campaignDisplayName: 'Road Game',
      targetRole: input.targetRole,
      expiresAt: new Date('2026-09-06T12:00:00Z'),
      state: 'usable',
    };
    return { ok: true as const, value: this.record };
  }

  async preview() {
    return this.record;
  }

  async accept() {
    if (this.record === undefined || this.record.state !== 'usable') {
      return { ok: false as const, error: 'unusable_invitation' as const };
    }
    this.record = { ...this.record, state: 'used' };
    return {
      ok: true as const,
      value: {
        user: { id: userId, username: 'player' },
        campaignId,
        role: 'player' as const,
        version: 1,
        updatedAt: '2026-08-30T12:00:00Z',
      },
    };
  }

  async revoke() {
    this.record = this.record === undefined ? undefined : { ...this.record, state: 'revoked' };
    return { ok: true as const, value: undefined };
  }

  async list() {
    return { ok: true as const, value: this.record === undefined ? [] : [this.record] };
  }
}

describe('InvitationService', () => {
  test('returns one raw token while persisting only its digest', async () => {
    const store = new FakeInvitationStore();
    const service = new InvitationService(store, { record: async () => undefined }, quietLog);
    const issued = await service.issue(userId, campaignId, { targetRole: 'player' });
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    expect(issued.value.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(store.digest).toHaveLength(32);
    expect(JSON.stringify(store.record)).not.toContain(issued.value.token);
  });

  test('preview exposes only approved public fields', async () => {
    const store = new FakeInvitationStore();
    const service = new InvitationService(store, { record: async () => undefined }, quietLog);
    const issued = await service.issue(userId, campaignId, { targetRole: 'player' });
    if (!issued.ok) throw new Error('fixture issue failed');
    const preview = await service.preview(issued.value.token);
    expect(preview).toEqual({
      ok: true,
      value: {
        campaignDisplayName: 'Road Game',
        targetRole: 'player',
        expiresAt: '2026-09-06T12:00:00.000Z',
      },
    });
    expect(JSON.stringify(preview)).not.toContain(campaignId);
  });

  test('rejects owner/observer and consumes a usable invitation once', async () => {
    const store = new FakeInvitationStore();
    const service = new InvitationService(store, { record: async () => undefined }, quietLog);
    expect(await service.issue(userId, campaignId, { targetRole: 'owner' })).toEqual({
      ok: false,
      error: 'invalid_role',
    });
    expect(await service.issue(userId, campaignId, { targetRole: 'observer' })).toEqual({
      ok: false,
      error: 'invalid_role',
    });
    const issued = await service.issue(userId, campaignId, { targetRole: 'player' });
    if (!issued.ok) throw new Error('fixture issue failed');
    expect((await service.accept(userId, issued.value.token)).ok).toBe(true);
    expect(await service.accept(userId, issued.value.token)).toEqual({
      ok: false,
      error: 'unusable_invitation',
    });
  });

  test('accepted invitation records membership.created after commit', async () => {
    const store = new FakeInvitationStore();
    const events: unknown[] = [];
    const service = new InvitationService(
      store,
      { record: async (event) => void events.push({ ...event, used: store.record?.state }) },
      quietLog,
    );
    const issued = await service.issue(userId, campaignId, { targetRole: 'player' });
    if (!issued.ok) throw new Error('fixture issue failed');
    expect(events).toEqual([]);
    expect((await service.accept(userId, issued.value.token)).ok).toBe(true);
    expect(events).toEqual([
      expect.objectContaining({
        campaignId,
        actor: { userId, campaignId, role: 'player' },
        action: 'membership.created',
        targetType: 'campaign_membership',
        targetId: userId,
        after: { role: 'player', version: 1, removed: false },
        private: false,
        used: 'used',
      }),
    ]);
    expect(JSON.stringify(events)).not.toContain(issued.value.token);
  });

  test('audit failure keeps the accepted membership and is observable for retry', async () => {
    const store = new FakeInvitationStore();
    const degraded: unknown[] = [];
    const service = new InvitationService(
      store,
      {
        record: async () => {
          throw new Error('audit down');
        },
      },
      { integrationDegraded: (...args) => void degraded.push(args) },
    );
    const issued = await service.issue(userId, campaignId, { targetRole: 'player' });
    if (!issued.ok) throw new Error('fixture issue failed');
    expect(await service.accept(userId, issued.value.token)).toMatchObject({
      ok: true,
      value: { role: 'player' },
    });
    expect(degraded).toEqual([
      ['audit', campaignId, userId, { event: 'membership.created', membershipVersion: 1 }],
    ]);
    expect(store.record?.state).toBe('used');
  });

  test('rejected acceptance records nothing', async () => {
    const store = new FakeInvitationStore();
    const record = mock(async (_event: unknown) => undefined);
    const service = new InvitationService(store, { record }, quietLog);
    expect((await service.accept(userId, 'Z'.repeat(43))).ok).toBe(false);
    expect((await service.accept(userId, 'short')).ok).toBe(false);
    expect(record).not.toHaveBeenCalled();
  });
});
