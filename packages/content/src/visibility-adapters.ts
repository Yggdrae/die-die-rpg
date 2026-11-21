import { createHash } from 'node:crypto';
import {
  type ResourceFacts,
  VISIBILITY_AUDIT_ACTIONS,
  type VisibilityAdapter,
  type VisibilityWrite,
  type VisibilityWriteResult,
} from '@rpg/authorization';
import { type ActorRef, GM_ONLY, type Visibility } from '@rpg/contracts';
import { intersectVisibility, isWithin, visibilityWithin } from './domain.ts';
import type {
  ContentTransaction,
  PostgresEntityRepository,
  PostgresPersonalNoteRepository,
  PostgresRelationshipRepository,
} from './infra/postgres/repository.ts';
import {
  CAMPAIGN_ENTITY_CLASS,
  ENTITY_RELATIONSHIP_CLASS,
  PERSONAL_NOTE_CLASS,
} from './policies.ts';
import type { EntityRecord, PersonalNoteRecord, RelationshipRecord } from './schemas.ts';

/**
 * Feature 04 integration. `campaign_entity` and `entity_relationship` register a
 * `VisibilityAdapter`, so the generic `PATCH .../resources/:class/:id/visibility` reveals and
 * un-reveals them and `ContentAccess` loads their facts. `personal_note` has no `reveal`; it
 * supplies a facts source (author included). Missing, foreign, and tombstoned records have no
 * facts (`tombstone_excluded`).
 *
 * Relationship bound (D-07 option A, `_db.md` "Visibility Invariant for Relationships"): a
 * relationship reveal wider than its endpoints' intersection is refused (`invariant_violation`,
 * B-1); an entity narrowing narrows every live relationship touching it in the same transaction,
 * each with one `visibility.unrevealed` event attributed to the entity's changer. Lock order:
 * entity rows (ascending id) before relationship rows `FOR UPDATE`.
 */

function entityFacts(record: EntityRecord): ResourceFacts {
  return {
    campaignId: record.campaignId,
    resourceClass: CAMPAIGN_ENTITY_CLASS,
    resourceId: record.id,
    visibility: record.visibility,
    version: record.version,
  };
}

function noteFacts(record: PersonalNoteRecord): ResourceFacts {
  return {
    campaignId: record.campaignId,
    resourceClass: PERSONAL_NOTE_CLASS,
    resourceId: record.id,
    visibility: record.visibility,
    version: record.version,
    authorUserId: record.authorUserId,
  };
}

export function relationshipFacts(record: RelationshipRecord): ResourceFacts {
  return {
    campaignId: record.campaignId,
    resourceClass: ENTITY_RELATIONSHIP_CLASS,
    resourceId: record.id,
    visibility: record.visibility,
    version: record.version,
  };
}

/** Feature 06 `DurableAuditRecorder.recordWithin`, structurally (no `@rpg/audit` dependency). */
export interface NarrowingAuditRecorder {
  recordWithin(
    executor: ContentTransaction,
    submission: {
      readonly event: {
        readonly campaignId: string;
        readonly actor: ActorRef;
        readonly action: string;
        readonly targetType: string;
        readonly targetId: string;
        readonly before: Record<string, unknown>;
        readonly after: Record<string, unknown>;
        readonly at: string;
        readonly private: boolean;
      };
      readonly originMutationId: string;
      readonly targetVisibility: { readonly visibility: Visibility };
    },
  ): Promise<unknown>;
}

/**
 * Stable origin ID of one narrowing: a relationship's version increases on every write, so
 * (relationship, new version) names exactly one event and a replay stores it once. UUID v8 shape.
 */
export function narrowingOriginId(relationshipId: string, version: number): string {
  const hex = createHash('sha256')
    .update(`rpg.content.relationship-narrowing:${relationshipId}:${version}`)
    .digest('hex')
    .slice(0, 32)
    .split('');
  hex[12] = '8';
  hex[16] = ((Number.parseInt(hex[16] ?? '0', 16) & 0x3) | 0x8).toString(16);
  const value = hex.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

export class EntityVisibilityAdapter implements VisibilityAdapter {
  readonly resourceClass = CAMPAIGN_ENTITY_CLASS;

  constructor(
    private readonly entities: PostgresEntityRepository,
    /** Relationship narrowing (task 09); absent only where no relationship can exist (tests). */
    private readonly narrowing?: {
      readonly relationships: PostgresRelationshipRepository;
      readonly audit: NarrowingAuditRecorder;
      readonly now?: () => Date;
    },
  ) {}

  async loadFacts(campaignId: string, resourceId: string): Promise<ResourceFacts | undefined> {
    const record = await this.entities.get(campaignId, resourceId);
    return record === undefined ? undefined : entityFacts(record);
  }

  /**
   * One conditional UPDATE, the audit enqueue, then relationship narrowing, all on the same
   * transaction (feature 06; D-07 option A).
   */
  writeVisibility(write: VisibilityWrite): Promise<VisibilityWriteResult> {
    return this.entities.transaction(async (transaction): Promise<VisibilityWriteResult> => {
      const result = await this.entities.writeVisibility(transaction, {
        campaignId: write.campaignId,
        id: write.resourceId,
        expectedVersion: write.expectedVersion,
        visibility: write.visibility,
      });
      if (!result.ok) {
        return {
          ok: false,
          reason: result.reason === 'version_conflict' ? 'version_conflict' : 'not_found',
        };
      }
      await write.recordAudit(transaction);
      await this.#narrowRelationships(transaction, result.record, write.actor);
      return { ok: true, facts: entityFacts(result.record) };
    });
  }

  /**
   * Every live relationship touching `entity` whose Visibility is no longer within its endpoints'
   * intersection is narrowed to `R ∩ S ∩ T` (version + 1), with one `visibility.unrevealed` event.
   * The other endpoint is read without a lock: a concurrent narrowing of it waits on the
   * relationship lock held here and then narrows again from the committed value.
   */
  async #narrowRelationships(
    transaction: ContentTransaction,
    entity: EntityRecord,
    actor: ActorRef | undefined,
  ): Promise<void> {
    const narrowing = this.narrowing;
    if (narrowing === undefined) return;
    const touching = await narrowing.relationships.listTouching(entity.campaignId, entity.id, {
      lock: 'update',
      executor: transaction,
    });
    for (const relationship of touching) {
      const otherId =
        relationship.sourceEntityId === entity.id
          ? relationship.targetEntityId
          : relationship.sourceEntityId;
      const other = await this.entities.get(entity.campaignId, otherId, {
        includeDeleted: true,
        executor: transaction,
      });
      const bound =
        other === undefined ? GM_ONLY : intersectVisibility(entity.visibility, other.visibility);
      if (visibilityWithin(relationship.visibility, bound)) continue;
      // Without an attributable actor the narrowing cannot be audited: refuse the whole change.
      if (actor === undefined) throw new Error('relationship narrowing needs the actor');
      const visibility = intersectVisibility(relationship.visibility, bound);
      const narrowed = await narrowing.relationships.narrow(transaction, {
        campaignId: entity.campaignId,
        id: relationship.id,
        visibility,
        actorUserId: actor.userId,
      });
      if (narrowed === undefined) continue;
      await narrowing.audit.recordWithin(transaction, {
        event: {
          campaignId: entity.campaignId,
          actor,
          action: VISIBILITY_AUDIT_ACTIONS.unreveal,
          targetType: ENTITY_RELATIONSHIP_CLASS,
          targetId: relationship.id,
          before: { visibility: relationship.visibility, version: relationship.version },
          after: { visibility: narrowed.visibility, version: narrowed.version },
          at: (narrowing.now?.() ?? new Date()).toISOString(),
          private: false,
        },
        originMutationId: narrowingOriginId(relationship.id, narrowed.version),
        // Same rule as feature 04's own visibility events: history naming recipients is GM-only.
        targetVisibility: { visibility: GM_ONLY },
      });
    }
  }
}

/**
 * `entity_relationship` (task 08). A reveal must stay within both endpoints' intersection; the
 * endpoints are locked `FOR SHARE` (ascending id) before the relationship `FOR UPDATE`, so a
 * concurrent endpoint narrowing and this write serialize. A wider value is refused with
 * `invariant_violation` (B-1): nothing changes and `recordAudit` is not called.
 */
export class RelationshipVisibilityAdapter implements VisibilityAdapter {
  readonly resourceClass = ENTITY_RELATIONSHIP_CLASS;

  constructor(
    private readonly relationships: PostgresRelationshipRepository,
    private readonly entities: PostgresEntityRepository,
  ) {}

  async loadFacts(campaignId: string, resourceId: string): Promise<ResourceFacts | undefined> {
    const record = await this.relationships.get(campaignId, resourceId);
    return record === undefined ? undefined : relationshipFacts(record);
  }

  writeVisibility(write: VisibilityWrite): Promise<VisibilityWriteResult> {
    return this.relationships.transaction(async (transaction): Promise<VisibilityWriteResult> => {
      const current = await this.relationships.get(write.campaignId, write.resourceId, {
        executor: transaction,
      });
      if (current === undefined) return { ok: false, reason: 'not_found' };
      const endpoints = new Map<string, EntityRecord>();
      for (const id of [current.sourceEntityId, current.targetEntityId].sort()) {
        const endpoint = await this.entities.get(write.campaignId, id, {
          includeDeleted: true,
          lock: 'share',
          executor: transaction,
        });
        if (endpoint !== undefined) endpoints.set(id, endpoint);
      }
      const locked = await this.relationships.get(write.campaignId, write.resourceId, {
        lock: 'update',
        executor: transaction,
      });
      if (locked === undefined) return { ok: false, reason: 'not_found' };
      if (locked.version !== write.expectedVersion) {
        return { ok: false, reason: 'version_conflict' };
      }
      const source = endpoints.get(locked.sourceEntityId);
      const target = endpoints.get(locked.targetEntityId);
      if (
        source === undefined ||
        target === undefined ||
        !isWithin(write.visibility, source.visibility, target.visibility)
      ) {
        return { ok: false, reason: 'invariant_violation' };
      }
      const result = await this.relationships.writeVisibility(transaction, {
        campaignId: write.campaignId,
        id: write.resourceId,
        expectedVersion: write.expectedVersion,
        visibility: write.visibility,
      });
      if (!result.ok) {
        return {
          ok: false,
          reason: result.reason === 'version_conflict' ? 'version_conflict' : 'not_found',
        };
      }
      await write.recordAudit(transaction);
      return { ok: true, facts: relationshipFacts(result.record) };
    });
  }
}

/** Structural `ResourceFactsSource` (apps/api `ContentAccess`, `AuditTargetAccess`). */
export interface PersonalNoteFactsSource {
  readonly resourceClass: string;
  loadFacts(campaignId: string, resourceId: string): Promise<ResourceFacts | undefined>;
}

export function personalNoteFactsSource(
  notes: Pick<PostgresPersonalNoteRepository, 'get'>,
): PersonalNoteFactsSource {
  return {
    resourceClass: PERSONAL_NOTE_CLASS,
    loadFacts: async (campaignId, resourceId) => {
      const record = await notes.get(campaignId, resourceId);
      return record === undefined ? undefined : noteFacts(record);
    },
  };
}
