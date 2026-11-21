import { describe, expect, test } from 'bun:test';
import {
  type CampaignAccessRevocationPublisher,
  CampaignAccessRevoked,
  ReplicaPurged,
  type ReplicaPurgeEvidence,
  type ReplicaPurgeListener,
  ReplicaPurgeWatermark,
  ReplicaWatermark,
  type TombstonePurgeDecision,
  type TombstonePurgeEvidence,
  TombstoneRef,
} from './revocation.ts';
import { check } from './validate.ts';

const campaignId = '11111111-1111-1111-1111-111111111111';
const userId = '22222222-2222-2222-2222-222222222222';
const replicaId = '33333333-3333-3333-3333-333333333333';
const recordId = '44444444-4444-4444-4444-444444444444';
const at = '2026-10-24T12:00:00Z';

describe('revocation and replica purge contracts', () => {
  test('carry only provider-neutral authority and watermark fields', () => {
    expect(
      check(CampaignAccessRevoked, {
        campaignId,
        userId,
        membershipVersion: 4,
        reason: 'removed',
        committedAt: '2026-08-30T12:00:00Z',
      }),
    ).toBe(true);
    expect(
      check(ReplicaPurgeWatermark, {
        campaignId,
        userId,
        replicaId,
        membershipVersion: 4,
        acknowledgedAt: '2026-08-30T12:01:00Z',
      }),
    ).toBe(true);
  });

  test('rejects provider-specific fields and invalid versions', () => {
    expect(
      check(CampaignAccessRevoked, {
        campaignId,
        userId,
        membershipVersion: 0,
        reason: 'removed',
        committedAt: '2026-08-30T12:00:00Z',
        powersyncBucket: 'private-provider-detail',
      }),
    ).toBe(false);
  });

  test('frozen publisher and evidence consumers stay source-compatible', async () => {
    const published: CampaignAccessRevoked[] = [];
    const publisher: CampaignAccessRevocationPublisher = {
      publish: async (event) => void published.push(event),
    };
    const evidence: ReplicaPurgeEvidence = {
      acknowledge: async () => undefined,
      safeToPurge: async () => false,
    };
    for (const reason of ['removed', 'role_changed', 'ownership_transferred', 'signed_out']) {
      const event = { campaignId, userId, membershipVersion: 2, reason, committedAt: at };
      expect(check(CampaignAccessRevoked, event)).toBe(true);
      if (check(CampaignAccessRevoked, event)) await publisher.publish(event);
    }
    expect(published).toHaveLength(4);
    expect(await evidence.safeToPurge({ campaignId, userId, membershipVersion: 2 })).toBe(false);
  });
});

describe('replica purge signal', () => {
  test('accepts each purge reason and rejects provider detail', () => {
    for (const reason of ['access_revoked', 'signed_out', 'campaign_deleted']) {
      expect(check(ReplicaPurged, { campaignId, replicaId, reason, purgedAt: at })).toBe(true);
    }
    expect(check(ReplicaPurged, { campaignId, replicaId, reason: 'evicted', purgedAt: at })).toBe(
      false,
    );
    expect(
      check(ReplicaPurged, {
        campaignId,
        replicaId,
        reason: 'access_revoked',
        purgedAt: at,
        sqlitePath: 'opfs://campaign.sqlite',
      }),
    ).toBe(false);
  });

  test('listener receives the validated fact', async () => {
    const seen: ReplicaPurged[] = [];
    const listener: ReplicaPurgeListener = {
      replicaPurged: async (event) => void seen.push(event),
    };
    await listener.replicaPurged({ campaignId, replicaId, reason: 'signed_out', purgedAt: at });
    expect(seen).toEqual([{ campaignId, replicaId, reason: 'signed_out', purgedAt: at }]);
  });
});

describe('replica watermark and tombstone purge evidence', () => {
  const watermark = {
    campaignId,
    userId,
    replicaId,
    scope: 'campaigns',
    sequence: 7,
    acknowledgedAt: at,
  };

  test('watermark is an authority sequence per scope, never a provider cursor', () => {
    expect(check(ReplicaWatermark, watermark)).toBe(true);
    expect(check(ReplicaWatermark, { ...watermark, sequence: 0 })).toBe(true);
    expect(check(ReplicaWatermark, { ...watermark, sequence: -1 })).toBe(false);
    expect(check(ReplicaWatermark, { ...watermark, sequence: 1.5 })).toBe(false);
    expect(check(ReplicaWatermark, { ...watermark, scope: 'Campaigns; drop' })).toBe(false);
    expect(check(ReplicaWatermark, { ...watermark, cursor: 'provider-opaque' })).toBe(false);
    expect(check(ReplicaWatermark, { ...watermark, bucket: 'by_user[]' })).toBe(false);
  });

  test('tombstone reference identifies one record deletion at one authority sequence', () => {
    const tombstone = { campaignId, scope: 'campaigns', recordId, sequence: 3, deletedAt: at };
    expect(check(TombstoneRef, tombstone)).toBe(true);
    expect(check(TombstoneRef, { ...tombstone, deletedAt: '2026-10-24 12:00' })).toBe(false);
    const { recordId: _omitted, ...missing } = tombstone;
    expect(check(TombstoneRef, missing)).toBe(false);
  });

  test('purge decision names every blocker and only `safe: true` permits purge', async () => {
    const decisions: TombstonePurgeDecision[] = [
      { safe: true },
      {
        safe: false,
        blockers: ['minimum_age', 'unacknowledged_replica', 'pending_mutation_reference'],
      },
    ];
    const evidence: TombstonePurgeEvidence = {
      acknowledge: async () => undefined,
      decide: async (tombstone) =>
        (tombstone.sequence <= watermark.sequence ? decisions[0] : decisions[1]) ?? {
          safe: false,
          blockers: [],
        },
    };
    await evidence.acknowledge(watermark);
    const now = new Date(at);
    expect(
      await evidence.decide(
        { campaignId, scope: 'campaigns', recordId, sequence: 7, deletedAt: at },
        now,
      ),
    ).toEqual({ safe: true });
    const blocked = await evidence.decide(
      { campaignId, scope: 'campaigns', recordId, sequence: 8, deletedAt: at },
      now,
    );
    expect(blocked.safe).toBe(false);
  });
});
