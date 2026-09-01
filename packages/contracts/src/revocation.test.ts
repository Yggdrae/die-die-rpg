import { describe, expect, test } from 'bun:test';
import { CampaignAccessRevoked, ReplicaPurgeWatermark } from './revocation.ts';
import { check } from './validate.ts';

const campaignId = '11111111-1111-1111-1111-111111111111';
const userId = '22222222-2222-2222-2222-222222222222';

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
        replicaId: '33333333-3333-3333-3333-333333333333',
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
});
