import { describe, expect, test } from 'bun:test';
import type { MembershipCacheRow } from '../contracts/schemas.ts';
import { reconcileMembershipCache } from './membership-cache.ts';

const cached: MembershipCacheRow = {
  campaignId: '11111111-1111-1111-1111-111111111111',
  userId: '22222222-2222-2222-2222-222222222222',
  role: 'gm',
  version: 3,
  updatedAt: '2026-08-30T12:00:00Z',
  removedAt: null,
};

describe('reconcileMembershipCache', () => {
  test('higher server version replaces the cached role', () => {
    expect(reconcileMembershipCache(cached, { ...cached, role: 'player', version: 4 })).toBe(
      'replace',
    );
    expect(reconcileMembershipCache(undefined, cached)).toBe('replace');
  });

  test('tombstone removes cached access, even with no cached row', () => {
    const tombstone = { ...cached, version: 4, removedAt: '2026-08-31T12:00:00Z' };
    expect(reconcileMembershipCache(cached, tombstone)).toBe('remove');
    expect(reconcileMembershipCache(undefined, tombstone)).toBe('remove');
  });

  test('stale or duplicate delivery never restores or downgrades the cache', () => {
    expect(reconcileMembershipCache(cached, { ...cached, role: 'owner', version: 2 })).toBe('keep');
    expect(reconcileMembershipCache(cached, cached)).toBe('keep');
    const tombstone = { ...cached, version: 4, removedAt: '2026-08-31T12:00:00Z' };
    expect(reconcileMembershipCache(tombstone, { ...cached, version: 3 })).toBe('keep');
  });
});
