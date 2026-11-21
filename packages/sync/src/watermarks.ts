import type {
  TombstonePurgeBlocker,
  TombstonePurgeDecision,
  TombstonePurgeEvidence,
  TombstoneRef,
} from '@rpg/contracts';
import { TOMBSTONE_MIN_AGE_MS } from './model.ts';

export interface TombstoneSubscriber {
  readonly replicaId: string;
  readonly eligibleAtDeletion: boolean;
  readonly acknowledgedSequence: number;
  readonly revokedAt?: string;
}

export interface TombstonePurgeCandidate {
  readonly campaignId: string;
  readonly tableName: string;
  readonly recordId: string;
  readonly sequence: number;
  readonly deletedAt: string;
  readonly subscribers: readonly TombstoneSubscriber[];
  readonly referencedByPendingMutation: boolean;
}

/** `_db.md` watermark rule as the provider-neutral `TombstonePurgeDecision` contract. */
export function decideTombstonePurge(
  candidate: TombstonePurgeCandidate,
  now: Date,
): TombstonePurgeDecision {
  const blockers: TombstonePurgeBlocker[] = [];
  if (now.getTime() - Date.parse(candidate.deletedAt) < TOMBSTONE_MIN_AGE_MS) {
    blockers.push('minimum_age');
  }
  const unacknowledged = candidate.subscribers
    .filter((subscriber) => subscriber.eligibleAtDeletion)
    .some(
      (subscriber) =>
        subscriber.acknowledgedSequence < candidate.sequence && subscriber.revokedAt === undefined,
    );
  if (unacknowledged) blockers.push('unacknowledged_replica');
  if (candidate.referencedByPendingMutation) blockers.push('pending_mutation_reference');
  return blockers.length === 0 ? { safe: true } : { safe: false, blockers };
}

export function isTombstoneSafeToPurge(candidate: TombstonePurgeCandidate, now: Date): boolean {
  return decideTombstonePurge(candidate, now).safe;
}

export interface TombstonePurgeReport {
  readonly purgeable: readonly TombstoneRef[];
  readonly retained: readonly {
    readonly tombstone: TombstoneRef;
    readonly blockers: readonly TombstonePurgeBlocker[];
  }[];
}

/**
 * Report-only purge pass: classifies candidates, deletes nothing. A tombstone owner may delete a
 * `purgeable` row only when its own retention policy allows a finite purge (feature 01 membership
 * tombstones stay indefinite until the 2026-10-24 contract note is ratified).
 */
export async function reportTombstonePurge(
  evidence: TombstonePurgeEvidence,
  tombstones: readonly TombstoneRef[],
  now: Date,
): Promise<TombstonePurgeReport> {
  const purgeable: TombstoneRef[] = [];
  const retained: { tombstone: TombstoneRef; blockers: readonly TombstonePurgeBlocker[] }[] = [];
  for (const tombstone of tombstones) {
    const decision = await evidence.decide(tombstone, now);
    if (decision.safe) purgeable.push(tombstone);
    else retained.push({ tombstone, blockers: decision.blockers });
  }
  return { purgeable, retained };
}

/**
 * Which subscribed users' replicas receive a scope at all. A scope delivered only to some roles
 * (for example the GM-private audit stream) must not wait for replicas that can never hold it.
 * `undefined` keeps every subscriber eligible (the default for platform scopes).
 */
export interface ReplicaScopeEligibility {
  eligibleUsers(
    campaignId: string,
    scope: string,
    userIds: readonly string[],
  ): Promise<ReadonlySet<string> | undefined>;
}

/** Server registry of replica subscriptions: the "eligible subscriber" set of the purge rule. */
export interface ReplicaSubscriptionRegistry {
  /** Idempotent; re-registering a revoked replica after a fresh access check re-activates it. */
  register(input: {
    readonly campaignId: string;
    readonly userId: string;
    readonly replicaId: string;
    /** Same clock as `CampaignAccessRevoked.committedAt`, so stale revocations compare safely. */
    readonly subscribedAt: Date;
  }): Promise<void>;
}
