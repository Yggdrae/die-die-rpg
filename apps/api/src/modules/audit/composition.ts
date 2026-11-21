import { createHash } from 'node:crypto';
import type {
  AuditDiagnostics,
  AuditFailureSignal,
  AuditSqlExecutor,
  AuditTargetDeclarations,
  DurableAuditRecorder,
} from '@rpg/audit';
import type { ResourcePolicyRegistry } from '@rpg/authorization';
import type { AuditRecorder } from '@rpg/contracts';
import type { RecoveryIssuanceAudit } from '@rpg/identity';
import type { MutationAuditParticipant } from '@rpg/sync';

interface DiagnosticLog {
  info(detail: object, message: string): void;
  warn(detail: object, message: string): void;
  error(detail: object, message: string): void;
}

/** Operator signals carry identifiers and safe codes only, never payload content. */
export function auditDiagnosticsFor(log: DiagnosticLog): AuditDiagnostics {
  const detail = (signal: Partial<AuditFailureSignal>) => ({
    eventId: signal.eventId,
    originMutationId: signal.originMutationId,
    store: signal.store,
    code: signal.code,
    attempt: signal.attempt,
    parkedIn: signal.parkedIn,
  });
  return {
    degraded: (signal) => log.warn(detail(signal), 'audit recording degraded; retry scheduled'),
    deadLettered: (signal) => log.error(detail(signal), 'audit event dead-lettered'),
    repaired: (signal) => log.info(detail(signal), 'audit event repaired'),
  };
}

/**
 * Feature 01 recovery issuance is account-scoped, so it goes to the operator-only account
 * store. The token ID is the origin ID: a replay of the same issuance stores one event.
 */
export function recoveryIssuanceAuditFor(recorder: DurableAuditRecorder): RecoveryIssuanceAudit {
  return {
    recordIssued: async (event) => {
      await recorder.recordAccount({
        originMutationId: event.tokenId,
        event: {
          subjectUserId: event.userId,
          actor:
            event.operatorReference === undefined
              ? { kind: 'operator' }
              : { kind: 'operator', reference: event.operatorReference },
          action: 'recovery.issued',
          targetType: 'recovery_token',
          targetId: event.tokenId,
          after: { expiresAt: event.expiresAt.toISOString() },
          at: event.issuedAt.toISOString(),
        },
      });
    },
  };
}

/**
 * Feature 06 target visibility from feature 04 declarations, for events whose caller supplied no
 * snapshot. A class answers only when its declaration fixes every record's visibility: a static
 * `defaultVisibility`, no `reveal` (so no record can differ from the default), and no Ownership
 * Rule on `read` (which needs the record's author). Undeclared classes, `explicit` defaults,
 * reveal-capable classes, and author-scoped classes return `undefined`, so the recorder keeps
 * the fail-closed GM-only snapshot; their owners must pass facts (as `VisibilityService` does).
 */
export function auditTargetDeclarationsFor(
  policies: Pick<ResourcePolicyRegistry, 'get'>,
): AuditTargetDeclarations {
  return {
    snapshotFor: (targetType) => {
      const policy = policies.get(targetType);
      if (
        policy === undefined ||
        policy.defaultVisibility === 'explicit' ||
        policy.capabilities.includes('reveal') ||
        policy.ownership?.capabilities.includes('read') === true
      ) {
        return undefined;
      }
      return { visibility: policy.defaultVisibility };
    },
  };
}

/** Audit recorder that stores nothing: for services whose audit travels in the sync envelope. */
export const DISCARD_AUDIT: AuditRecorder = { record: async () => undefined };

/**
 * Adapts the durable recorder to the provider-neutral sync port. The client mutation ID is the
 * origin ID, so a retry or lost-acknowledgement resubmit stores one event, and only an
 * accepted outcome becomes history. Never throws.
 *
 * In-transaction (`recordAcceptedWithin`): the opaque handle is the applier's PostgreSQL
 * transaction (a drizzle transaction from the domain repository), so the routed insert, or its
 * repair-outbox entry, commits or rolls back with the write. `recordWithin` isolates its own
 * failure in a savepoint and never aborts the transaction.
 *
 * `dead_lettered` means the transaction does not hold a pending event. Either the store and the
 * in-transaction outbox both failed, or the event is invalid and is already parked as dead. The
 * caller then retries after commit, where the commit outcome is known. That path repeats an
 * invalid event's dead letter idempotently (same event ID). For a gap, it reaches the outbox or
 * the memory queue on the audit pool.
 */
export function mutationAuditParticipantFor(
  recorder: Pick<DurableAuditRecorder, 'recordMutationOutcome' | 'recordWithin'>,
): MutationAuditParticipant {
  return {
    recordMutationOutcome: async ({ mutationId, outcome, audit, targetVisibility }) => {
      try {
        await recorder.recordMutationOutcome({ mutationId, outcome, audit, targetVisibility });
      } catch {
        // The recorder resolves by contract; a defect here must not reach the user's mutation.
      }
    },
    recordAcceptedWithin: async (transaction, { mutationId, audit, targetVisibility }) => {
      if (!isAuditSqlExecutor(transaction)) return false;
      try {
        const outcome = await recorder.recordWithin(transaction, {
          event: audit,
          originMutationId: mutationId,
          ...(targetVisibility === undefined ? {} : { targetVisibility }),
        });
        return outcome !== 'dead_lettered';
      } catch {
        return false;
      }
    },
  };
}

function isAuditSqlExecutor(value: unknown): value is AuditSqlExecutor {
  return (
    typeof value === 'object' &&
    value !== null &&
    'execute' in value &&
    typeof value.execute === 'function' &&
    'transaction' in value &&
    typeof value.transaction === 'function'
  );
}

/** Test/override path where only the frozen `record()` contract is available (no origin ID). */
export function recordOnlyMutationAuditParticipant(
  recorder: AuditRecorder,
): MutationAuditParticipant {
  return {
    recordMutationOutcome: async ({ outcome, audit }) => {
      if (outcome.status !== 'accepted') return;
      try {
        await recorder.record(audit);
      } catch {
        // Non-blocking by contract (feature 06 FR-009).
      }
    },
  };
}

const MEMBERSHIP_ORIGIN_NAMESPACE = 'rpg.identity.membership-audit:';

/**
 * Stable origin ID for one committed membership change: the same
 * (campaignId, userId, membershipVersion, action) always yields the same ID, so a replay after
 * `integrationDegraded` (or a duplicated post-commit call) stores one event. Shaped as a
 * version 8 UUID like the recorder's own derived IDs.
 */
export function membershipAuditOriginId(input: {
  readonly campaignId: string;
  readonly userId: string;
  readonly membershipVersion: number;
  readonly action: string;
}): string {
  const hex = createHash('sha256')
    .update(
      `${MEMBERSHIP_ORIGIN_NAMESPACE}${input.campaignId}:${input.userId}:${input.membershipVersion}:${input.action}`,
    )
    .digest('hex')
    .slice(0, 32)
    .split('');
  hex[12] = '8';
  hex[16] = ((Number.parseInt(hex[16] ?? '0', 16) & 0x3) | 0x8).toString(16);
  const value = hex.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

/**
 * Adapts the durable recorder to the frozen `AuditRecorder` port for feature 01 membership
 * events (`membership.created|removed|role_changed|ownership_transferred`). The port carries no
 * origin ID, so it is derived from the event itself: the membership event already holds the
 * target user and committed version. Events that are not membership changes keep the recorder's
 * generated origin.
 */
export function membershipAuditRecorderFor(
  recorder: Pick<DurableAuditRecorder, 'recordCampaign'>,
): AuditRecorder {
  return {
    record: async (event) => {
      const version = event.after?.version;
      const originMutationId =
        event.targetType === 'campaign_membership' && typeof version === 'number'
          ? membershipAuditOriginId({
              campaignId: event.campaignId,
              userId: event.targetId,
              membershipVersion: version,
              action: event.action,
            })
          : undefined;
      await recorder.recordCampaign({ event, originMutationId });
    },
  };
}
