import { CHARACTER_REPLICA_TABLE, CHARACTERS_SYNC_FEATURE_ID } from '@rpg/characters';
import type { CharacterService, CharactersTransaction } from '@rpg/characters/postgres';
import type { ApplierOutcome, AuthorityMutationContext, MutationApplier } from '@rpg/sync';

/**
 * Feature 15: create and delete of a character through `POST /sync/mutations` (D-11). Edits never come here:
 * they are feature 11 applications on class `character`. An audit envelope is refused, because the service
 * records `character.created` and `character.deleted` itself, keyed by the mutation, in the write transaction.
 *
 * Error codes: `invalid_payload`, `invalid_character`, `not_found_or_forbidden` (terminal); a stale delete
 * is a `conflict`; `authority_unavailable` is retryable.
 */

const INVALID: ApplierOutcome = { status: 'error', code: 'invalid_payload', retryable: false };
const UNAVAILABLE: ApplierOutcome = {
  status: 'error',
  code: 'authority_unavailable',
  retryable: true,
};

export class CharacterSyncMutationApplier implements MutationApplier {
  readonly featureId = CHARACTERS_SYNC_FEATURE_ID;
  readonly tableName = CHARACTER_REPLICA_TABLE;

  constructor(private readonly characters: CharacterService) {}

  async apply({ actor, mutation, recordAudit }: AuthorityMutationContext): Promise<ApplierOutcome> {
    if (mutation.audit !== undefined) return INVALID;
    const options = {
      originId: mutation.mutationId,
      ...(recordAudit === undefined
        ? {}
        : { fence: (transaction: CharactersTransaction) => recordAudit(transaction) }),
    };
    const accepted = (version: number): ApplierOutcome => ({
      status: 'accepted',
      version,
      cursor: `${mutation.tableName}:${mutation.recordId}:${version}`,
    });
    try {
      if (mutation.operation === 'insert' && mutation.expectedVersion === null) {
        const payload = mutation.payload;
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
        const written = await this.characters.create(actor, payload, options);
        if (written.ok) return accepted(written.record.version);
        return { status: 'error', code: written.code, retryable: false };
      }
      if (
        mutation.operation === 'tombstone' &&
        mutation.expectedVersion !== null &&
        Number.isSafeInteger(mutation.expectedVersion)
      ) {
        const written = await this.characters.tombstone(
          actor,
          {
            campaignId: mutation.campaignId,
            id: mutation.recordId,
            expectedVersion: mutation.expectedVersion,
          },
          options,
        );
        if (written.ok) return accepted(written.record.version);
        if (written.code === 'version_conflict') {
          return {
            status: 'conflict',
            expectedVersion: mutation.expectedVersion,
            actualVersion: written.current.version,
            currentValue: written.current,
          };
        }
        return { status: 'error', code: written.code, retryable: false };
      }
      return INVALID;
    } catch {
      return UNAVAILABLE;
    }
  }
}
