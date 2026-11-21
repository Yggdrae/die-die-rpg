/**
 * Browser-safe entry point: pure membership rules and contracts only. The main entry also loads
 * server-only modules (password hashing, PostgreSQL), which must never reach a browser bundle.
 */
export type { MembershipCacheRow } from './contracts/schemas.ts';
export {
  type MembershipCacheDecision,
  reconcileMembershipCache,
} from './domain/membership-cache.ts';
