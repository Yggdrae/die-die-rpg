import type { VisibilityService } from '@rpg/authorization';
import {
  CAMPAIGN_ENTITY_CLASS,
  CONTENT_SYNC_FEATURE_ID,
  ENTITY_REPLICA_TABLE,
  EntityReplicaSchema,
  EntityVisibilityChange,
  PERSONAL_NOTE_CLASS,
  PERSONAL_NOTE_REPLICA_TABLE,
  PersonalNoteReplicaSchema,
  RELATIONSHIP_REPLICA_TABLE,
  RelationshipReplicaSchema,
} from '@rpg/content';
import type {
  ContentWriteResult,
  EntityService,
  LongTextGuard,
  PersonalNoteService,
  RelationshipService,
} from '@rpg/content/postgres';
import type { Version } from '@rpg/contracts';
import type {
  ApplierOutcome,
  AuthorityMutationContext,
  LongTextHoldService,
  MutationApplier,
  PendingMutation,
} from '@rpg/sync';
import { Value } from '@sinclair/typebox/value';

/**
 * Feature 16 task 06: `POST /sync/mutations` is the only write path for entities and personal
 * notes (`_techspec.md` "Mutation Appliers"). Each applier validates the uploaded record, then the
 * application service re-decides through feature 04, compares versions, enforces the long-text
 * hold for the uploading session (B-2), and records the server-authored audit event inside the
 * write transaction (`recordAudit`, feature 06 task 02 pattern).
 *
 * Payload: the device's whole record (`SyncedRepository.upsert`/`softDelete`); for a changed
 * `description`/`body` it also carries `holdVersion`, the version of the hold it was typed under.
 * Visibility changes only through feature 04 `VisibilityService`: an entity update that carries
 * `visibilityChange` (feature 17 D-03, a queued reveal) and no envelope is handed to it whole, with
 * the mutation ID as the audit origin.
 *
 * Error codes: `invalid_payload`, `not_found_or_forbidden` (missing, foreign, denied, existing id:
 * identical), `record_deleted`, `hold_required` (all terminal); `authority_unavailable` is
 * retryable.
 */

type HoldPort = Pick<LongTextHoldService, 'mayWriteWithin'>;

const INVALID: ApplierOutcome = { status: 'error', code: 'invalid_payload', retryable: false };
const UNAVAILABLE: ApplierOutcome = {
  status: 'error',
  code: 'authority_unavailable',
  retryable: true,
};

function holdVersionOf(payload: unknown): number | undefined {
  if (typeof payload !== 'object' || payload === null || !('holdVersion' in payload)) {
    return undefined;
  }
  const value = payload.holdVersion;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? value : undefined;
}

/**
 * The single-writer check (`LongTextHoldService.mayWriteWithin`), run by the service inside its
 * write transaction: a current, unexpired hold on this field owned by the uploading session at the
 * version the text was written under. No session (B-2: never from the payload) or no hold version
 * is `hold_required`. The content and sync pools reach one database, so the hold row can be locked
 * on the content transaction: a takeover commits before this check or after the write, never
 * between them.
 */
function longTextGuard(
  holds: HoldPort,
  resourceClass: string,
  { mutation, sessionId }: AuthorityMutationContext,
): LongTextGuard {
  return async (fieldPath, transaction) => {
    const holdVersion = holdVersionOf(mutation.payload);
    if (sessionId === undefined || holdVersion === undefined) return false;
    return holds.mayWriteWithin(transaction, {
      field: {
        campaignId: mutation.campaignId,
        resourceClass,
        recordId: mutation.recordId,
        fieldPath,
      },
      holderSessionId: sessionId,
      expectedVersion: holdVersion,
    });
  };
}

function outcome<T extends { readonly version: number }>(
  mutation: PendingMutation,
  result: ContentWriteResult<T>,
): ApplierOutcome {
  if (result.ok) {
    return {
      status: 'accepted',
      version: result.value.version,
      cursor: `${mutation.tableName}:${mutation.recordId}:${result.value.version}`,
    };
  }
  const failure = result.error;
  if (failure.code === 'version_conflict') {
    return {
      status: 'conflict',
      expectedVersion: mutation.expectedVersion ?? 0,
      actualVersion: failure.current.version,
      currentValue: failure.current,
    };
  }
  return { status: 'error', code: failure.code, retryable: false };
}

/** Runs one service call; a persistence fault is retryable and never a partial write. */
async function guarded(work: () => Promise<ApplierOutcome>): Promise<ApplierOutcome> {
  try {
    return await work();
  } catch {
    return UNAVAILABLE;
  }
}

function isVersion(value: number | null): value is Version {
  return value !== null && Number.isSafeInteger(value) && value >= 1;
}

/** Envelope binding shared by both appliers: record id and campaign come from the mutation. */
function boundRecord(
  mutation: PendingMutation,
  schema:
    | typeof EntityReplicaSchema
    | typeof PersonalNoteReplicaSchema
    | typeof RelationshipReplicaSchema,
): boolean {
  const payload = mutation.payload;
  return (
    Value.Check(schema, payload) &&
    payload.id === mutation.recordId &&
    payload.campaignId === mutation.campaignId
  );
}

type VisibilityPort = Pick<VisibilityService, 'change'>;

/** Feature 04 rejections an unauthorized actor may reach: one safe answer for all of them. */
const HIDDEN_REJECTIONS = new Set([
  'not_found',
  'denied',
  'actor_not_member',
  'unknown_resource_class',
]);

function visibilityChangeOf(payload: unknown): EntityVisibilityChange | 'invalid' | undefined {
  if (typeof payload !== 'object' || payload === null || !('visibilityChange' in payload)) {
    return undefined;
  }
  const change = payload.visibilityChange;
  return Value.Check(EntityVisibilityChange, change) ? change : 'invalid';
}

export class EntitySyncMutationApplier implements MutationApplier {
  readonly featureId = CONTENT_SYNC_FEATURE_ID;
  readonly tableName = ENTITY_REPLICA_TABLE;

  constructor(
    private readonly entities: EntityService,
    private readonly holds: HoldPort,
    private readonly visibility?: VisibilityPort,
  ) {}

  /**
   * Feature 17 D-03, D-04: the queued reveal. The service re-decides `reveal`, checks targets and
   * the previewed version, writes, and audits in one transaction; the payload's own Visibility and
   * fields are ignored.
   */
  async #changeVisibility(
    context: AuthorityMutationContext,
    change: EntityVisibilityChange,
  ): Promise<ApplierOutcome> {
    const { actor, mutation } = context;
    if (
      this.visibility === undefined ||
      mutation.audit !== undefined ||
      mutation.operation !== 'update' ||
      !isVersion(mutation.expectedVersion)
    ) {
      return INVALID;
    }
    const expectedVersion = mutation.expectedVersion;
    const visibility = this.visibility;
    return guarded(async () => {
      const result = await visibility.change(actor.userId, {
        campaignId: mutation.campaignId,
        resourceClass: CAMPAIGN_ENTITY_CLASS,
        resourceId: mutation.recordId,
        operation: change.operation,
        target: change.target,
        expectedVersion,
        mutationId: mutation.mutationId,
      });
      if (result.status === 'changed' || result.status === 'unchanged') {
        return {
          status: 'accepted',
          version: result.facts.version,
          cursor: `${mutation.tableName}:${mutation.recordId}:${result.facts.version}`,
        };
      }
      if (result.status === 'conflict') {
        const current = await this.entities.readable(actor, mutation.campaignId, mutation.recordId);
        if (current === undefined) {
          return { status: 'error', code: 'not_found_or_forbidden', retryable: false };
        }
        return {
          status: 'conflict',
          expectedVersion,
          actualVersion: current.version,
          currentValue: current,
        };
      }
      return {
        status: 'error',
        code: HIDDEN_REJECTIONS.has(result.reason)
          ? 'not_found_or_forbidden'
          : 'invalid_visibility',
        retryable: false,
      };
    });
  }

  apply(context: AuthorityMutationContext): Promise<ApplierOutcome> {
    const { actor, mutation, recordAudit } = context;
    const change = visibilityChangeOf(mutation.payload);
    if (change === 'invalid') return Promise.resolve(INVALID);
    if (change !== undefined) {
      if (!boundRecord(mutation, EntityReplicaSchema)) return Promise.resolve(INVALID);
      return this.#changeVisibility(context, change);
    }
    // Content mutations always carry the feature 06 envelope (the device repository writes it).
    if (mutation.audit === undefined) return Promise.resolve(INVALID);
    const audit = recordAudit;
    if (mutation.operation === 'tombstone') {
      if (!isVersion(mutation.expectedVersion)) return Promise.resolve(INVALID);
      const expectedVersion = mutation.expectedVersion;
      return guarded(async () =>
        outcome(
          mutation,
          await this.entities.tombstone(
            actor,
            { campaignId: mutation.campaignId, id: mutation.recordId, expectedVersion },
            { audit },
          ),
        ),
      );
    }
    if (!boundRecord(mutation, EntityReplicaSchema)) return Promise.resolve(INVALID);
    const record = mutation.payload as typeof EntityReplicaSchema.static;
    if (mutation.operation === 'insert' && mutation.expectedVersion === null) {
      return guarded(async () =>
        outcome(
          mutation,
          await this.entities.create(
            actor,
            {
              campaignId: mutation.campaignId,
              id: mutation.recordId,
              type: record.type,
              name: record.name,
              summary: record.summary,
              description: record.description,
              tags: record.tags,
              fields: record.fields,
              metadata: record.metadata,
              visibility: record.visibility,
            },
            { audit },
          ),
        ),
      );
    }
    if (mutation.operation !== 'update' || !isVersion(mutation.expectedVersion)) {
      return Promise.resolve(INVALID);
    }
    const expectedVersion = mutation.expectedVersion;
    return guarded(async () =>
      outcome(
        mutation,
        await this.entities.update(
          actor,
          {
            campaignId: mutation.campaignId,
            id: mutation.recordId,
            expectedVersion,
            changes: {
              type: record.type,
              name: record.name,
              summary: record.summary,
              description: record.description,
              tags: record.tags,
              fields: record.fields,
              metadata: record.metadata,
            },
            visibility: record.visibility,
          },
          { audit, longText: longTextGuard(this.holds, CAMPAIGN_ENTITY_CLASS, context) },
        ),
      ),
    );
  }
}

export class PersonalNoteSyncMutationApplier implements MutationApplier {
  readonly featureId = CONTENT_SYNC_FEATURE_ID;
  readonly tableName = PERSONAL_NOTE_REPLICA_TABLE;

  constructor(
    private readonly notes: PersonalNoteService,
    private readonly holds: HoldPort,
  ) {}

  apply(context: AuthorityMutationContext): Promise<ApplierOutcome> {
    const { actor, mutation, recordAudit } = context;
    if (mutation.audit === undefined) return Promise.resolve(INVALID);
    const audit = recordAudit;
    if (mutation.operation === 'tombstone') {
      if (!isVersion(mutation.expectedVersion)) return Promise.resolve(INVALID);
      const expectedVersion = mutation.expectedVersion;
      return guarded(async () =>
        outcome(
          mutation,
          await this.notes.tombstone(
            actor,
            { campaignId: mutation.campaignId, id: mutation.recordId, expectedVersion },
            { audit },
          ),
        ),
      );
    }
    if (!boundRecord(mutation, PersonalNoteReplicaSchema)) return Promise.resolve(INVALID);
    const record = mutation.payload as typeof PersonalNoteReplicaSchema.static;
    if (mutation.operation === 'insert' && mutation.expectedVersion === null) {
      // The author is the uploader and the Visibility is fixed `players:[author]` (BR-007).
      const visibility = record.visibility;
      if (
        record.authorUserId !== actor.userId ||
        visibility.mode !== 'players' ||
        visibility.playerIds.length !== 1 ||
        visibility.playerIds[0] !== actor.userId
      ) {
        return Promise.resolve(INVALID);
      }
      return guarded(async () =>
        outcome(
          mutation,
          await this.notes.create(
            actor,
            {
              campaignId: mutation.campaignId,
              id: mutation.recordId,
              name: record.name,
              body: record.body,
              tags: record.tags,
              metadata: record.metadata,
            },
            { audit },
          ),
        ),
      );
    }
    if (mutation.operation !== 'update' || !isVersion(mutation.expectedVersion)) {
      return Promise.resolve(INVALID);
    }
    const expectedVersion = mutation.expectedVersion;
    return guarded(async () =>
      outcome(
        mutation,
        await this.notes.update(
          actor,
          {
            campaignId: mutation.campaignId,
            id: mutation.recordId,
            expectedVersion,
            changes: {
              name: record.name,
              body: record.body,
              tags: record.tags,
              metadata: record.metadata,
            },
          },
          { audit, longText: longTextGuard(this.holds, PERSONAL_NOTE_CLASS, context) },
        ),
      ),
    );
  }
}

/**
 * Task 09: links between two entities, insert and tombstone only (a kind change is a tombstone
 * plus a new link; an `update` is `invalid_payload`). The endpoints, kind, self-link, duplicate,
 * and Visibility bound are checked by `RelationshipService` under the endpoint locks.
 */
export class RelationshipSyncMutationApplier implements MutationApplier {
  readonly featureId = CONTENT_SYNC_FEATURE_ID;
  readonly tableName = RELATIONSHIP_REPLICA_TABLE;

  constructor(private readonly relationships: RelationshipService) {}

  apply(context: AuthorityMutationContext): Promise<ApplierOutcome> {
    const { actor, mutation, recordAudit } = context;
    if (mutation.audit === undefined) return Promise.resolve(INVALID);
    const audit = recordAudit;
    if (mutation.operation === 'tombstone') {
      if (!isVersion(mutation.expectedVersion)) return Promise.resolve(INVALID);
      const expectedVersion = mutation.expectedVersion;
      return guarded(async () =>
        outcome(
          mutation,
          await this.relationships.tombstone(
            actor,
            { campaignId: mutation.campaignId, id: mutation.recordId, expectedVersion },
            { audit },
          ),
        ),
      );
    }
    if (
      mutation.operation !== 'insert' ||
      mutation.expectedVersion !== null ||
      !boundRecord(mutation, RelationshipReplicaSchema)
    ) {
      return Promise.resolve(INVALID);
    }
    const record = mutation.payload as typeof RelationshipReplicaSchema.static;
    return guarded(async () =>
      outcome(
        mutation,
        await this.relationships.create(
          actor,
          {
            campaignId: mutation.campaignId,
            id: mutation.recordId,
            sourceEntityId: record.sourceEntityId,
            targetEntityId: record.targetEntityId,
            kind: record.kind,
            visibility: record.visibility,
          },
          { audit },
        ),
      ),
    );
  }
}
