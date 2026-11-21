import type { MembershipCacheRow } from '../contracts/schemas.ts';

/**
 * What a client cache does with an incoming server membership row (`_db.md` conflict rules).
 * `replace`: adopt the newer role. `remove`: drop cached actor and request campaign cleanup.
 * `keep`: stale or duplicate delivery; the cache is already at or past this version.
 */
export type MembershipCacheDecision = 'replace' | 'remove' | 'keep';

export function reconcileMembershipCache(
  cached: MembershipCacheRow | undefined,
  incoming: MembershipCacheRow,
): MembershipCacheDecision {
  if (cached !== undefined && incoming.version <= cached.version) return 'keep';
  return incoming.removedAt === null ? 'replace' : 'remove';
}
