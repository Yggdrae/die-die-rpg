import { DICE_ROLL_REPLICA_TABLE, DICE_SYNC_FEATURE_ID } from '@rpg/dice';
import type { DiceTransaction, RollService } from '@rpg/dice/postgres';
import type { ApplierOutcome, AuthorityMutationContext, MutationApplier } from '@rpg/sync';

/**
 * Feature 09: `POST /sync/mutations` is the only write path for rolls (`_techspec.md` "Mutation
 * Applier"). Insert only: a roll is never edited or removed (D-09). A mutation carrying an audit
 * envelope is refused, so no client-composed event can enter feature 06 through this table (D-08).
 *
 * The mutation hook carries the feature 03 access fence, so a role lost during the upload aborts the
 * write. It writes no event, because no envelope exists.
 *
 * Error codes: `invalid_payload`, `invalid_roll`, `not_found_or_forbidden` (all terminal);
 * `authority_unavailable` is retryable. A CHECK violation is terminal too: the record would be refused
 * on every retry, and a retried roll must never block the queue behind it.
 */

const INVALID: ApplierOutcome = { status: 'error', code: 'invalid_payload', retryable: false };
const INVALID_ROLL: ApplierOutcome = { status: 'error', code: 'invalid_roll', retryable: false };
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

export class DiceRollSyncMutationApplier implements MutationApplier {
  readonly featureId = DICE_SYNC_FEATURE_ID;
  readonly tableName = DICE_ROLL_REPLICA_TABLE;

  constructor(private readonly rolls: RollService) {}

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
      const fence =
        recordAudit === undefined
          ? {}
          : { fence: (transaction: DiceTransaction) => recordAudit(transaction) };
      const written = await this.rolls.record(actor, payload, fence);
      if (written.ok) {
        return {
          status: 'accepted',
          version: written.record.version,
          cursor: `${mutation.tableName}:${mutation.recordId}:${written.record.version}`,
        };
      }
      return written.code === 'invalid_roll'
        ? INVALID_ROLL
        : { status: 'error', code: written.code, retryable: false };
    } catch (error) {
      return isCheckViolation(error) ? INVALID_ROLL : UNAVAILABLE;
    }
  }
}
