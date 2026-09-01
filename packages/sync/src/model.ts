import type {
  ActorRef,
  AuditEvent,
  DeferredConflict,
  EntityEnvelope,
  SemanticOp,
} from '@rpg/contracts';

export const SYNC_BOOKKEEPING_LIMIT_BYTES = 10 * 1024 * 1024;
export const HOLD_TTL_MS = 120_000;
export const HOLD_RENEW_INTERVAL_MS = 30_000;
export const TOMBSTONE_MIN_AGE_MS = 90 * 24 * 60 * 60 * 1_000;

export type ReplicaState = 'populating' | 'available' | 'dropping' | 'error';
export type MutationState = 'pending' | 'uploading' | 'accepted' | 'conflicted' | 'rejected';
export type MutationOperation = 'insert' | 'update' | 'tombstone' | 'semantic' | 'resolution';

export interface PendingMutation {
  readonly mutationId: string;
  readonly campaignId: string;
  readonly featureId: string;
  readonly tableName: string;
  readonly recordId: string;
  readonly operation: MutationOperation;
  readonly expectedVersion: number | null;
  readonly payload: unknown;
  readonly causalSequence: number;
  readonly state: MutationState;
  readonly attemptCount: number;
  readonly recordedAt: string;
}

export interface LocalMutationInput<T extends EntityEnvelope> {
  readonly tableName: string;
  readonly featureId: string;
  readonly value: T;
  readonly expectedVersion: number | null;
  readonly operation: 'insert' | 'update';
  readonly mutationId: string;
  readonly recordedAt: string;
  readonly audit: Omit<AuditEvent, 'id'>;
}

export interface MutationConflict extends DeferredConflict {
  readonly conflictId: string;
  readonly mutationId: string;
  readonly campaignId: string;
  readonly featureId: string;
  readonly submittedValue: unknown;
  readonly currentValue: unknown;
  readonly resolutionState: 'unresolved' | 'deferred' | 'resolved';
}

export type ConflictResolutionChoice = 'keep_authority' | 'resubmit' | 'manual';

export interface ConflictResolutionResult {
  readonly conflictId: string;
  readonly choice: ConflictResolutionChoice;
  readonly mutationId?: string;
  readonly resolvedVersion: number;
}

export type MutationOutcome =
  | {
      readonly mutationId: string;
      readonly status: 'accepted';
      readonly acceptedVersion: number;
      readonly serverCursor: string;
    }
  | {
      readonly mutationId: string;
      readonly status: 'conflict';
      readonly expectedVersion: number;
      readonly actualVersion: number;
      readonly currentValue: unknown;
    }
  | {
      readonly mutationId: string;
      readonly status: 'error';
      readonly code: string;
      readonly retryable: boolean;
    };

export interface MutationBatch {
  readonly campaignId: string;
  readonly replicaId: string;
  readonly mutations: readonly PendingMutation[];
}

export interface MutationUploader {
  upload(batch: MutationBatch): Promise<readonly MutationOutcome[]>;
}

export interface SyncStatus {
  readonly state: 'synchronized' | 'pending' | 'offline' | 'error';
  readonly pendingCount: number;
  readonly connected: boolean;
  readonly initialSyncProgress?: number;
  readonly errorCode?: string;
  readonly lastSyncAt?: string;
}

export interface LongTextFieldRef {
  readonly campaignId: string;
  readonly resourceClass: string;
  readonly recordId: string;
  readonly fieldPath: string;
}

export interface LongTextHold extends LongTextFieldRef {
  readonly holderUserId: string;
  readonly holderSessionId: string;
  readonly acquiredAt: string;
  readonly renewedAt: string;
  readonly expiresAt: string;
  readonly version: number;
}

export interface HoldNotice {
  readonly kind: 'taken_over' | 'expired' | 'released';
  readonly field: LongTextFieldRef;
  readonly previousHolderUserId: string;
  readonly version: number;
}

export interface AuthorityMutationContext {
  readonly actor: ActorRef;
  readonly mutation: PendingMutation;
}

export type ApplierOutcome =
  | { readonly status: 'accepted'; readonly version: number; readonly cursor: string }
  | {
      readonly status: 'conflict';
      readonly expectedVersion: number;
      readonly actualVersion: number;
      readonly currentValue: unknown;
    }
  | { readonly status: 'error'; readonly code: string; readonly retryable: boolean };

export interface MutationApplier {
  readonly featureId: string;
  readonly tableName: string;
  apply(context: AuthorityMutationContext): Promise<ApplierOutcome>;
}

export interface SemanticMutationPayload {
  readonly operations: readonly SemanticOp[];
}

export interface ReplicaSnapshotRecord {
  readonly tableName: string;
  readonly record: EntityEnvelope;
}
