import type { ResourceFacts, VisibilityActorResolver } from '@rpg/authorization';
import { type ActorRef, check, Id, type Visibility } from '@rpg/contracts';
import { normalizeTag } from './domain.ts';
import { CAMPAIGN_ENTITY_CLASS } from './policies.ts';
import type { EntityRecord } from './schemas.ts';

/**
 * Feature 16 task 10: the published entity directory (FR-016, `_techspec.md` "Interfaces and
 * Contracts"). Features 17, 18, and 19 resolve and list entities for a user through this API only
 * (server side) or through `EntityLocalRepository` (device), never through feature 16 tables or
 * `@rpg/content/postgres`.
 *
 * - The caller names a user; the role is resolved here through identity's `ActorResolver`, so a
 *   role (or a Visibility) in the caller's input changes nothing.
 * - Every record is decided through feature 04 `AuthorizationService.decide` (`read`) on facts
 *   loaded from storage.
 * - Unreadable and missing IDs are both absent; a non-member gets the same empty answer.
 * - Personal notes are a different class and table: never returned.
 * - Nothing here is scene-specific (D-02): feature 18 resolves its scene like any other entity.
 */

/** FR-016 summary: no description, custom fields, or tags. */
export interface EntitySummary {
  readonly id: string;
  readonly type: string;
  readonly name: string;
  readonly summary: string;
  readonly visibility: Visibility;
  readonly deleted: boolean;
}

export interface EntityDirectoryFilter {
  readonly type?: string;
  /** Normalized like stored tags (D-18) before matching. */
  readonly tag?: string;
  /** Case-insensitive name fragment. */
  readonly nameFragment?: string;
}

export interface EntityDirectoryPage {
  readonly offset?: number;
  readonly limit?: number;
}

/** Only the user identity is read from the caller; an `ActorRef` may be passed as is. */
export interface DirectoryCaller {
  readonly userId: string;
}

/** The storage reads the directory needs (`PostgresEntityRepository` satisfies it). */
export interface EntityDirectorySource {
  get(
    campaignId: string,
    id: string,
    options?: { readonly includeDeleted?: boolean },
  ): Promise<EntityRecord | undefined>;
  list(
    campaignId: string,
    filter?: {
      readonly type?: string;
      readonly tag?: string;
      readonly nameFragment?: string;
    },
  ): Promise<EntityRecord[]>;
}

export interface EntityReadDecider {
  decide(actor: ActorRef, capability: 'read', facts: ResourceFacts): { readonly allowed: boolean };
}

export const DIRECTORY_DEFAULT_LIMIT = 50;
export const DIRECTORY_MAX_LIMIT = 200;
export const DIRECTORY_MAX_RESOLVE = 200;

/** Feature 04 facts of an entity record (Visibility and version as stored). */
export function entityFactsOf(record: EntityRecord): ResourceFacts {
  return {
    campaignId: record.campaignId,
    resourceClass: CAMPAIGN_ENTITY_CLASS,
    resourceId: record.id,
    visibility: record.visibility,
    version: record.version,
  };
}

export function entitySummaryOf(record: EntityRecord): EntitySummary {
  return {
    id: record.id,
    type: record.type,
    name: record.name,
    summary: record.summary,
    visibility: record.visibility,
    deleted: record.deletedAt !== undefined,
  };
}

function bounded(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || !Number.isSafeInteger(value) || value < 0) return fallback;
  return Math.min(value, max);
}

export class EntityDirectory {
  constructor(
    private readonly deps: {
      readonly entities: EntityDirectorySource;
      readonly decider: EntityReadDecider;
      /** Identity's `ActorResolver` (the only sanctioned membership read). */
      readonly actors: VisibilityActorResolver;
    },
  ) {}

  /**
   * Readable entities by ID. Missing, foreign, unreadable, and (unless `includeDeleted`) deleted
   * IDs are all absent. `includeDeleted` returns a readable tombstone as `deleted: true` (a
   * broken reference, e.g. a session's deleted current scene).
   */
  async resolve(
    caller: DirectoryCaller,
    campaignId: string,
    ids: readonly string[],
    options: { readonly includeDeleted?: boolean } = {},
  ): Promise<Map<string, EntitySummary>> {
    const resolved = new Map<string, EntitySummary>();
    const actor = await this.#actor(caller, campaignId);
    if (actor === undefined) return resolved;
    for (const id of [...new Set(ids)].slice(0, DIRECTORY_MAX_RESOLVE)) {
      if (!check(Id, id)) continue;
      const record = await this.deps.entities.get(campaignId, id, {
        includeDeleted: options.includeDeleted === true,
      });
      if (record === undefined || !this.#readable(actor, record)) continue;
      resolved.set(id, entitySummaryOf(record));
    }
    return resolved;
  }

  /** Live readable entities; `total` counts the permitted set only. */
  async list(
    caller: DirectoryCaller,
    campaignId: string,
    filter: EntityDirectoryFilter = {},
    page: EntityDirectoryPage = {},
  ): Promise<{ readonly items: EntitySummary[]; readonly total: number }> {
    const actor = await this.#actor(caller, campaignId);
    if (actor === undefined) return { items: [], total: 0 };
    const tag = filter.tag === undefined ? undefined : normalizeTag(filter.tag);
    const rows = await this.deps.entities.list(campaignId, {
      ...(filter.type === undefined ? {} : { type: filter.type }),
      ...(tag === undefined || tag === '' ? {} : { tag }),
      ...(filter.nameFragment === undefined ? {} : { nameFragment: filter.nameFragment }),
    });
    const permitted = rows.filter((record) => this.#readable(actor, record));
    const offset = bounded(page.offset, 0, Number.MAX_SAFE_INTEGER);
    const limit = Math.max(1, bounded(page.limit, DIRECTORY_DEFAULT_LIMIT, DIRECTORY_MAX_LIMIT));
    return {
      items: permitted.slice(offset, offset + limit).map(entitySummaryOf),
      total: permitted.length,
    };
  }

  async #actor(caller: DirectoryCaller, campaignId: string): Promise<ActorRef | undefined> {
    if (!check(Id, campaignId) || typeof caller.userId !== 'string') return undefined;
    const resolved = await this.deps.actors.resolve(caller.userId, campaignId);
    return resolved.ok && resolved.value.campaignId === campaignId ? resolved.value : undefined;
  }

  #readable(actor: ActorRef, record: EntityRecord): boolean {
    return (
      record.campaignId === actor.campaignId &&
      this.deps.decider.decide(actor, 'read', entityFactsOf(record)).allowed
    );
  }
}
