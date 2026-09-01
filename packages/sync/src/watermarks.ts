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

export function isTombstoneSafeToPurge(candidate: TombstonePurgeCandidate, now: Date): boolean {
  if (now.getTime() - Date.parse(candidate.deletedAt) < TOMBSTONE_MIN_AGE_MS) return false;
  if (candidate.referencedByPendingMutation) return false;
  return candidate.subscribers
    .filter((subscriber) => subscriber.eligibleAtDeletion)
    .every(
      (subscriber) =>
        subscriber.acknowledgedSequence >= candidate.sequence || subscriber.revokedAt !== undefined,
    );
}
