import type {
  ActorRef,
  AuditEvent,
  DeferredConflict,
  EntityEnvelope,
  Role,
  SemanticOp,
  Visibility,
} from '@rpg/contracts';

import type { MutationAuditPayload } from './schemas.ts';

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
  /**
   * Validated audit payload recorded atomically with the local write (`sync_audit_envelopes`).
   * Absent only on mutations from clients that predate the envelope.
   */
  readonly audit?: MutationAuditPayload;
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
  readonly audit: MutationAuditPayload;
}

/**
 * Port to the audit feature, provider-neutral: `@rpg/sync` never imports an audit package.
 * The composition root adapts the durable recorder (`recordMutationOutcome`).
 */
export interface MutationAuditInput {
  /** Client mutation ID. It is the audit origin ID, so retries and resubmits store one event. */
  readonly mutationId: string;
  readonly outcome: MutationOutcome;
  /**
   * The uploaded payload, bound by the authority to the mutation (campaign, target) and to the
   * actor it resolved. Client-supplied `campaignId`, `targetType`, `targetId`, and `actor`
   * never survive.
   */
  readonly audit: Omit<AuditEvent, 'id'>;
  /** Supplied with a server-authored event (`AuthoredMutationAudit`). */
  readonly targetVisibility?: MutationAuditSnapshot;
}

/** Accepted-write audit recorded inside the applier's domain transaction. */
export interface MutationAuditWithinInput {
  /** Client mutation ID, used as the audit origin ID. */
  readonly mutationId: string;
  /** Bound exactly like `MutationAuditInput.audit`. */
  readonly audit: Omit<AuditEvent, 'id'>;
  /** Supplied with a server-authored event (`AuthoredMutationAudit`). */
  readonly targetVisibility?: MutationAuditSnapshot;
}

export interface MutationAuditParticipant {
  /**
   * After-commit path. It runs once the applier result and its receipt are durable, but only
   * when the domain transaction did not already hold the event. It runs again on every receipt
   * replay (lost acknowledgement, resubmit), so an interrupted attempt is repaired.
   * Implementations must be idempotent by `mutationId`, record history only for an `accepted`
   * outcome, and never throw: an audit fault must not reject or delay-fail the user's mutation.
   * The caller also swallows a rejection.
   */
  recordMutationOutcome(input: MutationAuditInput): Promise<void>;
  /**
   * Same-transaction path (feature 06 `_db.md` Write Path), reached only through
   * `AuthorityMutationContext.recordAudit`: the applier calls it inside the domain transaction
   * after its accepted write matched. `transaction` is that transaction's opaque handle.
   *
   * Resolve `true` when the transaction now holds the event (inserted, duplicate, or parked in
   * the repair outbox), so it commits or rolls back with the write. Resolve `false` to have the
   * caller record it after commit instead. Must never abort the transaction and should not
   * throw; a rejection counts as `false`.
   */
  recordAcceptedWithin?(transaction: unknown, input: MutationAuditWithinInput): Promise<boolean>;
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

/** Client-side per-item outcome of one drained mutation, with its routing identity. */
export interface DrainedMutationOutcome {
  readonly mutationId: string;
  readonly campaignId: string;
  readonly featureId: string;
  readonly tableName: string;
  readonly recordId: string;
  readonly operation: MutationOperation;
  /** `rejected` is a terminal authority error; `retry` stays pending for the next drain. */
  readonly result: 'accepted' | 'conflict' | 'rejected' | 'retry';
  readonly outcome: MutationOutcome;
}

export interface MutationDrainReport {
  readonly state: 'offline' | 'empty' | 'uploaded' | 'transport_error' | 'invalid_outcome';
  /** In causal order; empty unless `state === 'uploaded'`. */
  readonly outcomes: readonly DrainedMutationOutcome[];
  readonly conflicts: readonly MutationConflict[];
}

export interface SyncStatus {
  /**
   * `synchronizing`: connected with no pending work, but no consistent authorized checkpoint yet
   * (initial sync, `initialSyncProgress` set). Never reported as `synchronized`.
   */
  readonly state: 'synchronized' | 'synchronizing' | 'pending' | 'offline' | 'error';
  /** Unresolved (not yet chosen) conflicts; any makes the state `error`. */
  readonly unresolvedConflicts?: number;
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

/**
 * Same-transaction hook of the authority: the feature 06 audit event, when the mutation carries an
 * envelope and the participant supports `recordAcceptedWithin`, and the check that the uploader's
 * access did not change since authorization, when the resolver supports `resolveWithin`.
 *
 * Call it at most once, inside the transaction that applied the accepted write and only after
 * that write matched, passing the transaction's opaque handle, and do not swallow what it throws:
 * audit trouble never throws, but changed access throws so that the write rolls back. If an applier
 * does not call it (no transaction, or a no-op write), the authority records the event after commit
 * under the same origin ID, and that write is not checked.
 */
export type MutationAuditHook = (
  transaction: unknown,
  authored?: AuthoredMutationAudit,
) => Promise<void>;

/**
 * Feature 06 target visibility snapshot, structurally (`@rpg/sync` never imports an audit
 * package): who may read the event, applied on top of the target's current rule.
 */
export interface MutationAuditSnapshot {
  readonly visibility: Visibility;
  readonly authorUserId?: string;
}

/**
 * Server-authored audit content (additive, feature 16 task 06). An applier that knows exactly
 * what changed passes it to `recordAudit`; the authority then records it instead of the uploaded
 * envelope's `action`/`targetType`/`before`/`after`/`private`, so client-composed values (long
 * text, custom fields) never reach history. Campaign, target ID, actor, origin ID, and `at`
 * stay bound by the authority as for the envelope. Only offered when the mutation carries an
 * envelope.
 */
export interface AuthoredMutationAudit {
  readonly action: string;
  /** The Resource Class the audit reader authorizes against (not the replica table). */
  readonly targetType: string;
  readonly before?: Record<string, unknown>;
  readonly after?: Record<string, unknown>;
  readonly targetVisibility?: MutationAuditSnapshot;
}

export interface AuthorityMutationContext {
  readonly actor: ActorRef;
  readonly mutation: PendingMutation;
  readonly recordAudit?: MutationAuditHook;
  /**
   * Authenticated session that uploaded the batch (B-2, feature 16): passed by the sync route
   * from the session cookie, never read from the payload. Long-text appliers require it for
   * `LongTextHoldService.mayWriteWithin`; absent means `hold_required`. Others ignore it.
   */
  readonly sessionId?: string;
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

/**
 * Creation-scoped authorization: the authenticated user uploads the insert of a campaign that
 * does not exist yet, so no membership can resolve. Only the campaign-create mutation qualifies
 * (insert, `recordId === campaignId`, `expectedVersion === null`); the applier must prove
 * `creatorUserId` is the record creator and commit the creator's owner membership atomically.
 */
export interface CreationMutationContext {
  readonly creatorUserId: string;
  readonly mutation: PendingMutation;
  /**
   * Same contract as `AuthorityMutationContext.recordAudit`. The event names the creator as
   * `owner`, the membership the applier commits in the same transaction.
   */
  readonly recordAudit?: MutationAuditHook;
}

export interface MutationApplier {
  readonly featureId: string;
  readonly tableName: string;
  apply(context: AuthorityMutationContext): Promise<ApplierOutcome>;
  /** Present only on the applier that owns campaign creation. Absent means fail closed. */
  applyCreation?(context: CreationMutationContext): Promise<ApplierOutcome>;
}

export interface SemanticMutationPayload {
  readonly operations: readonly SemanticOp[];
}

/**
 * Current user's membership as replicated to the device: exactly the feature 01 `_db.md` cache
 * fields (structurally identical to identity's `MembershipCacheRow`). `observer` is reserved and
 * never persisted in MVP.
 */
export interface CachedMembership {
  readonly campaignId: string;
  readonly userId: string;
  readonly role: Exclude<Role, 'observer'>;
  readonly version: number;
  readonly updatedAt: string;
  readonly removedAt: string | null;
}

/** `replace`: adopt the newer row. `remove`: tombstone, drop the replica. `keep`: stale/duplicate. */
export type MembershipReconcileDecision = 'replace' | 'remove' | 'keep';

/**
 * Feature 01 owns the version/tombstone rule; the composition root injects identity's
 * `reconcileMembershipCache`, so feature 03 never re-implements or imports it.
 */
export type MembershipReconcile = (
  cached: CachedMembership | undefined,
  incoming: CachedMembership,
) => MembershipReconcileDecision;

export interface ReplicaSnapshotRecord {
  readonly tableName: string;
  readonly record: EntityEnvelope;
}
