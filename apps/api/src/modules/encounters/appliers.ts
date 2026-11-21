import {
  ENCOUNTER_NOTE_REPLICA_TABLE,
  ENCOUNTER_REPLICA_TABLE,
  ENCOUNTERS_SYNC_FEATURE_ID,
  PARTICIPANT_REPLICA_TABLE,
} from '@rpg/encounters';
import type {
  EncounterService,
  EncountersTransaction,
  EncounterWriteResult,
} from '@rpg/encounters/postgres';
import type { ApplierOutcome, AuthorityMutationContext, MutationApplier } from '@rpg/sync';

/**
 * Feature 19 through `POST /sync/mutations`: one applier per writable table (`_techspec.md` "Authority"). Instance
 * states have none: they change only through feature 11 (class `encounter_participant`). An audit envelope is
 * refused, because the service records `encounter.started`, `encounter.ended`, `encounter.participant_added`,
 * `encounter.participant_removed`, and `encounter.participant_revealed` itself, keyed by the mutation.
 *
 * Error codes: `invalid_payload`, `invalid_encounter`, `not_found_or_forbidden` (terminal); a stale version is a
 * `conflict`; `authority_unavailable` is retryable.
 */

const INVALID: ApplierOutcome = { status: 'error', code: 'invalid_payload', retryable: false };
const UNAVAILABLE: ApplierOutcome = {
  status: 'error',
  code: 'authority_unavailable',
  retryable: true,
};

type Table =
  | typeof ENCOUNTER_REPLICA_TABLE
  | typeof ENCOUNTER_NOTE_REPLICA_TABLE
  | typeof PARTICIPANT_REPLICA_TABLE;

function addressed(context: AuthorityMutationContext): boolean {
  const { payload, recordId, campaignId } = context.mutation;
  return (
    typeof payload === 'object' &&
    payload !== null &&
    'id' in payload &&
    payload.id === recordId &&
    'campaignId' in payload &&
    payload.campaignId === campaignId
  );
}

function outcome<T extends { readonly version: number }>(
  context: AuthorityMutationContext,
  written: EncounterWriteResult<T>,
): ApplierOutcome {
  const { mutation } = context;
  if (written.ok) {
    return {
      status: 'accepted',
      version: written.record.version,
      cursor: `${mutation.tableName}:${mutation.recordId}:${written.record.version}`,
    };
  }
  if (written.code === 'version_conflict') {
    return {
      status: 'conflict',
      expectedVersion: mutation.expectedVersion ?? 0,
      actualVersion: written.current.version,
      currentValue: written.current,
    };
  }
  return { status: 'error', code: written.code, retryable: false };
}

export class EncounterSyncMutationApplier implements MutationApplier {
  readonly featureId = ENCOUNTERS_SYNC_FEATURE_ID;

  constructor(
    readonly tableName: Table,
    private readonly encounters: EncounterService,
  ) {}

  async apply(context: AuthorityMutationContext): Promise<ApplierOutcome> {
    const { actor, mutation, recordAudit } = context;
    if (mutation.audit !== undefined) return INVALID;
    const options = {
      originId: mutation.mutationId,
      ...(recordAudit === undefined
        ? {}
        : { fence: (transaction: EncountersTransaction) => recordAudit(transaction) }),
    };
    const version = mutation.expectedVersion;
    const versioned = version !== null && Number.isSafeInteger(version);
    const insert = mutation.operation === 'insert' && version === null;
    const update = mutation.operation === 'update' && versioned;
    try {
      if (
        this.tableName === PARTICIPANT_REPLICA_TABLE &&
        mutation.operation === 'tombstone' &&
        versioned
      ) {
        return outcome(
          context,
          await this.encounters.removeParticipant(
            actor,
            { campaignId: mutation.campaignId, id: mutation.recordId, expectedVersion: version },
            options,
          ),
        );
      }
      if (!addressed(context)) return INVALID;
      switch (this.tableName) {
        case ENCOUNTER_REPLICA_TABLE:
          if (insert) {
            return outcome(context, await this.encounters.start(actor, mutation.payload, options));
          }
          return update
            ? outcome(
                context,
                await this.encounters.update(actor, mutation.payload, version, options),
              )
            : INVALID;
        case ENCOUNTER_NOTE_REPLICA_TABLE:
          return insert || update
            ? outcome(
                context,
                await this.encounters.saveNote(actor, mutation.payload, version, options),
              )
            : INVALID;
        case PARTICIPANT_REPLICA_TABLE:
          if (insert) {
            return outcome(
              context,
              await this.encounters.addParticipant(actor, mutation.payload, options),
            );
          }
          return update
            ? outcome(
                context,
                await this.encounters.updateParticipant(actor, mutation.payload, version, options),
              )
            : INVALID;
      }
    } catch {
      return UNAVAILABLE;
    }
  }
}
