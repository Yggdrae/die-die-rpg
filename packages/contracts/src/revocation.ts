import { type Static, Type } from '@sinclair/typebox';
import { Id, Timestamp, Version } from './primitives.ts';

/**
 * Provider-neutral access-revocation, replica-purge, and tombstone-watermark boundary.
 *
 * Contract-change notes: `.speckit/features/00-platform-foundation/2026-08-30-revocation-purge-
 * contract-change.md` and `2026-10-24-replica-watermark-contract-change.md`. Shapes carry
 * campaign, user, replica, version, sequence, and time facts only: never a provider bucket,
 * local database path, transport, or provider cursor.
 */

export const CampaignAccessRevocationReason = Type.Union(
  [
    Type.Literal('removed'),
    Type.Literal('role_changed'),
    Type.Literal('ownership_transferred'),
    Type.Literal('signed_out'),
  ],
  { $id: 'CampaignAccessRevocationReason' },
);
export type CampaignAccessRevocationReason = Static<typeof CampaignAccessRevocationReason>;

/** Committed authority fact published by feature 01 after a membership change. */
export const CampaignAccessRevoked = Type.Object(
  {
    campaignId: Id,
    userId: Id,
    membershipVersion: Version,
    reason: CampaignAccessRevocationReason,
    committedAt: Timestamp,
  },
  { additionalProperties: false, $id: 'CampaignAccessRevoked' },
);
export type CampaignAccessRevoked = Static<typeof CampaignAccessRevoked>;

/**
 * Published after commit. Implemented by feature 03; delivery failure never restores access,
 * because server authorization re-resolves current membership on every request.
 */
export interface CampaignAccessRevocationPublisher {
  publish(event: CampaignAccessRevoked): Promise<void>;
}

/** Replica acknowledgement that it observed membership at `membershipVersion` (or was dropped). */
export const ReplicaPurgeWatermark = Type.Object(
  {
    campaignId: Id,
    userId: Id,
    replicaId: Id,
    membershipVersion: Version,
    acknowledgedAt: Timestamp,
  },
  { additionalProperties: false, $id: 'ReplicaPurgeWatermark' },
);
export type ReplicaPurgeWatermark = Static<typeof ReplicaPurgeWatermark>;

/** Feature 01 asks this before purging a membership tombstone; until `true`, retain it. */
export interface ReplicaPurgeEvidence {
  acknowledge(watermark: ReplicaPurgeWatermark): Promise<void>;
  safeToPurge(input: {
    readonly campaignId: string;
    readonly userId: string;
    readonly membershipVersion: number;
  }): Promise<boolean>;
}

/** Why a device must destroy one campaign replica (local data, queue, conflicts, cached role). */
export const ReplicaPurgeReason = Type.Union(
  [Type.Literal('access_revoked'), Type.Literal('signed_out'), Type.Literal('campaign_deleted')],
  { $id: 'ReplicaPurgeReason' },
);
export type ReplicaPurgeReason = Static<typeof ReplicaPurgeReason>;

/** Device-local fact emitted once a campaign replica was destroyed. */
export const ReplicaPurged = Type.Object(
  {
    campaignId: Id,
    replicaId: Id,
    reason: ReplicaPurgeReason,
    purgedAt: Timestamp,
  },
  { additionalProperties: false, $id: 'ReplicaPurged' },
);
export type ReplicaPurged = Static<typeof ReplicaPurged>;

/**
 * Device-side hook for local state outside the replica (feature 05 attachment bytes, feature 01
 * cached role). Called after the replica is destroyed; must be idempotent per campaign.
 */
export interface ReplicaPurgeListener {
  replicaPurged(event: ReplicaPurged): Promise<void>;
}

/**
 * Authority-assigned, monotonically increasing per (campaign, scope). Not a clock and not a
 * provider cursor.
 */
export const AuthoritySequence = Type.Integer({ minimum: 0, $id: 'AuthoritySequence' });
export type AuthoritySequence = Static<typeof AuthoritySequence>;

/** Synchronized table/resource scope a watermark applies to, e.g. `campaigns`. */
export const ReplicaScope = Type.String({
  minLength: 1,
  maxLength: 100,
  pattern: '^[a-z][a-z0-9_]*$',
  $id: 'ReplicaScope',
});
export type ReplicaScope = Static<typeof ReplicaScope>;

/** A replica observed every authority change in `scope` up to and including `sequence`. */
export const ReplicaWatermark = Type.Object(
  {
    campaignId: Id,
    userId: Id,
    replicaId: Id,
    scope: ReplicaScope,
    sequence: AuthoritySequence,
    acknowledgedAt: Timestamp,
  },
  { additionalProperties: false, $id: 'ReplicaWatermark' },
);
export type ReplicaWatermark = Static<typeof ReplicaWatermark>;

/** An authority tombstone that may eventually be purged. */
export const TombstoneRef = Type.Object(
  {
    campaignId: Id,
    scope: ReplicaScope,
    recordId: Id,
    sequence: AuthoritySequence,
    deletedAt: Timestamp,
  },
  { additionalProperties: false, $id: 'TombstoneRef' },
);
export type TombstoneRef = Static<typeof TombstoneRef>;

/** Each `_db.md` watermark rule that can still hold a tombstone back. */
export type TombstonePurgeBlocker =
  | 'minimum_age'
  | 'unacknowledged_replica'
  | 'pending_mutation_reference';

export type TombstonePurgeDecision =
  | { readonly safe: true }
  | { readonly safe: false; readonly blockers: readonly TombstonePurgeBlocker[] };

/** Implemented by feature 03. A tombstone owner purges only on `{ safe: true }`. */
export interface TombstonePurgeEvidence {
  acknowledge(watermark: ReplicaWatermark): Promise<void>;
  decide(tombstone: TombstoneRef, now: Date): Promise<TombstonePurgeDecision>;
}
