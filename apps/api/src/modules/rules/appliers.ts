import { RULES_MARK_REPLICA_TABLE, RULES_SYNC_FEATURE_ID } from '@rpg/rules';
import type { RulesMarkService, RulesTransaction } from '@rpg/rules/postgres';
import type { ApplierOutcome, AuthorityMutationContext, MutationApplier } from '@rpg/sync';

/**
 * Feature 14 through `POST /sync/mutations`: a user's section marks (bookmark, last view). Insert and update both
 * merge (D-09), so the outcome is never a conflict; no delete in P0. Marks are not audited (D-10), so an audit
 * envelope is refused.
 *
 * Error codes: `invalid_payload`, `invalid_rules_mark`, `not_found_or_forbidden` (terminal);
 * `authority_unavailable` is retryable.
 */

const INVALID: ApplierOutcome = { status: 'error', code: 'invalid_payload', retryable: false };
const UNAVAILABLE: ApplierOutcome = {
  status: 'error',
  code: 'authority_unavailable',
  retryable: true,
};

export class RulesMarkSyncMutationApplier implements MutationApplier {
  readonly featureId = RULES_SYNC_FEATURE_ID;
  readonly tableName = RULES_MARK_REPLICA_TABLE;

  constructor(private readonly marks: RulesMarkService) {}

  async apply(context: AuthorityMutationContext): Promise<ApplierOutcome> {
    const { actor, mutation, recordAudit } = context;
    if (mutation.audit !== undefined) return INVALID;
    if (mutation.operation !== 'insert' && mutation.operation !== 'update') return INVALID;
    const { payload } = mutation;
    if (
      typeof payload !== 'object' ||
      payload === null ||
      !('id' in payload) ||
      payload.id !== mutation.recordId ||
      !('campaignId' in payload) ||
      payload.campaignId !== mutation.campaignId
    ) {
      return INVALID;
    }
    try {
      const written = await this.marks.save(actor, payload, {
        ...(recordAudit === undefined
          ? {}
          : { fence: (transaction: RulesTransaction) => recordAudit(transaction) }),
      });
      if (!written.ok) return { status: 'error', code: written.code, retryable: false };
      return {
        status: 'accepted',
        version: written.record.version,
        cursor: `${mutation.tableName}:${mutation.recordId}:${written.record.version}`,
      };
    } catch {
      return UNAVAILABLE;
    }
  }
}
