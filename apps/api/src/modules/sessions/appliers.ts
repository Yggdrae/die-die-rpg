import {
  SESSION_LOG_REPLICA_TABLE,
  SESSION_NOTE_REPLICA_TABLE,
  SESSION_REPLICA_TABLE,
  SESSIONS_SYNC_FEATURE_ID,
} from '@rpg/sessions';
import type {
  SessionService,
  SessionsTransaction,
  SessionWriteResult,
} from '@rpg/sessions/postgres';
import type { ApplierOutcome, AuthorityMutationContext, MutationApplier } from '@rpg/sync';

/**
 * Feature 18 through `POST /sync/mutations`: one applier per table (`_techspec.md` "Authority"). An audit envelope
 * is refused, because the service records `session.started`, `session.paused`, `session.resumed`, `session.ended`,
 * and `session.scene_changed` itself, keyed by the mutation, in the write transaction.
 *
 * Error codes: `invalid_payload`, `invalid_session`, `session_already_open`, `not_found_or_forbidden` (terminal);
 * a stale version is a `conflict`; `authority_unavailable` is retryable.
 */

const INVALID: ApplierOutcome = { status: 'error', code: 'invalid_payload', retryable: false };
const UNAVAILABLE: ApplierOutcome = {
  status: 'error',
  code: 'authority_unavailable',
  retryable: true,
};

type Table =
  | typeof SESSION_REPLICA_TABLE
  | typeof SESSION_NOTE_REPLICA_TABLE
  | typeof SESSION_LOG_REPLICA_TABLE;

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
  written: SessionWriteResult<T>,
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

export class SessionSyncMutationApplier implements MutationApplier {
  readonly featureId = SESSIONS_SYNC_FEATURE_ID;

  constructor(
    readonly tableName: Table,
    private readonly sessions: SessionService,
  ) {}

  async apply(context: AuthorityMutationContext): Promise<ApplierOutcome> {
    const { actor, mutation, recordAudit } = context;
    if (mutation.audit !== undefined || !addressed(context)) return INVALID;
    const options = {
      originId: mutation.mutationId,
      ...(recordAudit === undefined
        ? {}
        : { fence: (transaction: SessionsTransaction) => recordAudit(transaction) }),
    };
    const version = mutation.expectedVersion;
    const insert = mutation.operation === 'insert' && version === null;
    const update =
      mutation.operation === 'update' && version !== null && Number.isSafeInteger(version);
    try {
      switch (this.tableName) {
        case SESSION_REPLICA_TABLE:
          if (insert)
            return outcome(context, await this.sessions.start(actor, mutation.payload, options));
          if (update) {
            return outcome(
              context,
              await this.sessions.update(actor, mutation.payload, version, options),
            );
          }
          return INVALID;
        case SESSION_NOTE_REPLICA_TABLE:
          if (insert || update) {
            return outcome(
              context,
              await this.sessions.saveNote(actor, mutation.payload, version, options),
            );
          }
          return INVALID;
        case SESSION_LOG_REPLICA_TABLE:
          return insert
            ? outcome(context, await this.sessions.addEntry(actor, mutation.payload, options))
            : INVALID;
      }
    } catch {
      return UNAVAILABLE;
    }
  }
}
