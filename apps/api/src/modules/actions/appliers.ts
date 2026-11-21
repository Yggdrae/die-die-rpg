import { ACTIONS_SYNC_FEATURE_ID, EFFECT_REPLICA_TABLE } from '@rpg/actions';
import type { ActionsTransaction, EffectApplicationService } from '@rpg/actions/postgres';
import type { ApplierOutcome, AuthorityMutationContext, MutationApplier } from '@rpg/sync';

/**
 * Feature 11: `POST /sync/mutations` is the only write path for effect applications (`_techspec.md`
 * "Mutation Applier"). Insert only: an application is never edited or removed. A mutation carrying an audit
 * envelope is refused: the service records the event itself, keyed by the application's id (D-19), so a
 * resend under a new mutation cannot add a second one, and no client-composed event can enter.
 *
 * The mutation hook carries only the feature 03 access fence here.
 *
 * Error codes: `invalid_payload`, `invalid_effect`, `unknown_target`, `target_changed`,
 * `not_found_or_forbidden` (all terminal); `authority_unavailable` is retryable. A CHECK violation is
 * terminal too: it would refuse on every retry, and a queued write must not block what follows it.
 */

const INVALID: ApplierOutcome = { status: 'error', code: 'invalid_payload', retryable: false };
const INVALID_EFFECT: ApplierOutcome = {
  status: 'error',
  code: 'invalid_effect',
  retryable: false,
};
const UNAVAILABLE: ApplierOutcome = {
  status: 'error',
  code: 'authority_unavailable',
  retryable: true,
};
const CHECK_VIOLATION = '23514';

function isCheckViolation(error: unknown): boolean {
  const codeOf = (value: unknown) =>
    typeof value === 'object' && value !== null && 'code' in value ? value.code : undefined;
  const cause = typeof error === 'object' && error !== null ? (error as Error).cause : undefined;
  return codeOf(error) === CHECK_VIOLATION || codeOf(cause) === CHECK_VIOLATION;
}

export class EffectApplicationSyncMutationApplier implements MutationApplier {
  readonly featureId = ACTIONS_SYNC_FEATURE_ID;
  readonly tableName = EFFECT_REPLICA_TABLE;

  constructor(private readonly applications: EffectApplicationService) {}

  async apply({ actor, mutation, recordAudit }: AuthorityMutationContext): Promise<ApplierOutcome> {
    if (
      mutation.operation !== 'insert' ||
      mutation.expectedVersion !== null ||
      mutation.audit !== undefined
    ) {
      return INVALID;
    }
    const payload = mutation.payload;
    if (
      typeof payload !== 'object' ||
      payload === null ||
      !('id' in payload) ||
      !('campaignId' in payload) ||
      payload.id !== mutation.recordId ||
      payload.campaignId !== mutation.campaignId
    ) {
      return INVALID;
    }
    try {
      const written = await this.applications.record(
        actor,
        payload,
        recordAudit === undefined
          ? {}
          : { fence: (transaction: ActionsTransaction) => recordAudit(transaction) },
      );
      if (written.ok) {
        return {
          status: 'accepted',
          version: written.record.version,
          cursor: `${mutation.tableName}:${mutation.recordId}:${written.record.version}`,
        };
      }
      return { status: 'error', code: written.code, retryable: false };
    } catch (error) {
      return isCheckViolation(error) ? INVALID_EFFECT : UNAVAILABLE;
    }
  }
}
