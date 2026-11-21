import { applyVisibilityChange } from '@rpg/authorization';
import {
  err,
  ok,
  type RepositoryError,
  type Result,
  type SyncedRepository,
  type Visibility,
} from '@rpg/contracts';
import {
  type ContentRuleError,
  checkEntityType,
  checkLongText,
  checkRelationshipKind,
  checkSummary,
  isWithin,
  normalizeCustomFields,
  normalizeName,
  normalizeTag,
  normalizeTags,
  prepareQuickCreate,
} from './domain.ts';
import { CAMPAIGN_ENTITY_POLICY, ENTITY_RELATIONSHIP_POLICY } from './policies.ts';
import type {
  EntityRecord,
  EntityVisibilityChange,
  PersonalNoteRecord,
  RelationshipRecord,
} from './schemas.ts';
import {
  CONTENT_CONFIGURATION,
  type ContentConfiguration,
  PERSONAL_NOTE_RECORD_TYPE,
  RELATIONSHIP_RECORD_TYPE,
} from './types.ts';

/**
 * Feature 16 device repositories (`_techspec.md` "Offline and Synchronization", FR-012, FR-016).
 * They sit on the feature 03 `SyncedRepository` (local replica + queue): every write is validated
 * with the same pure rules the authority applies (`domain.ts`), is visible at once, and is queued
 * with its audit envelope for `POST /sync/mutations`, where the feature 16 appliers re-decide.
 *
 * Long text (`description`, `body`) is saved only with the version of the current hold it was
 * typed under (`holdVersion`, sent in the payload); text typed without a hold is a device draft
 * (D-17) and never queued. Reads cover only what the device's replica holds, which is only what
 * it may read.
 */

export type LocalContentError = ContentRuleError | 'not_found' | RepositoryError;

export interface LocalActor {
  readonly userId: string;
  readonly campaignId: string;
}

export interface LocalEntityFilter {
  readonly type?: string;
  /** Normalized like stored tags (D-18) before matching. */
  readonly tag?: string;
  /** Case-insensitive name fragment. */
  readonly nameFragment?: string;
  /** Narrows the permitted set by Visibility mode (never widens: only local rows are read). */
  readonly visibilityMode?: Visibility['mode'];
}

/**
 * The one entity filter (BDD "Filtering narrows the permitted set", "A GM finds an entity by a
 * name fragment"): every given criterion must match; an empty filter matches all.
 */
export function matchesEntityFilter(record: EntityRecord, filter: LocalEntityFilter): boolean {
  const tag =
    filter.tag === undefined || filter.tag.trim() === '' ? undefined : normalizeTag(filter.tag);
  const fragment = filter.nameFragment?.trim().toLowerCase();
  return (
    (!filter.type || record.type === filter.type) &&
    (tag === undefined || record.tags.includes(tag)) &&
    (fragment === undefined || fragment === '' || record.name.toLowerCase().includes(fragment)) &&
    (filter.visibilityMode === undefined || record.visibility.mode === filter.visibilityMode)
  );
}

function defaultVisibility(): Visibility {
  const value = CAMPAIGN_ENTITY_POLICY.defaultVisibility;
  return value === 'explicit' ? { mode: 'gm_only' } : value;
}

/**
 * The record as the authority stores it: the transport-only `holdVersion` and `visibilityChange`
 * (feature 17) are never kept.
 */
function stripTransport<T extends object>(record: T): T {
  if (!('holdVersion' in record) && !('visibilityChange' in record)) return record;
  const {
    holdVersion: _hold,
    visibilityChange: _change,
    ...rest
  } = record as T & {
    holdVersion?: unknown;
    visibilityChange?: unknown;
  };
  return rest as T;
}

function live<T extends { readonly deletedAt?: string }>(record: T): boolean {
  return record.deletedAt === undefined;
}

export class EntityLocalRepository {
  readonly #config: ContentConfiguration;
  readonly #visibilityRecords: SyncedRepository<EntityRecord> | undefined;
  private readonly clock: () => Date;
  private readonly createId: () => string;

  constructor(
    private readonly records: SyncedRepository<EntityRecord>,
    private readonly actor: LocalActor,
    options: {
      readonly configuration?: ContentConfiguration;
      readonly clock?: () => Date;
      readonly createId?: () => string;
      /**
       * Feature 17 D-03: the same table without the audit envelope, for reveal and un-reveal, which
       * feature 04 `VisibilityService` audits itself.
       */
      readonly visibilityRecords?: SyncedRepository<EntityRecord>;
    } = {},
  ) {
    this.#visibilityRecords = options.visibilityRecords;
    this.#config = options.configuration ?? CONTENT_CONFIGURATION;
    this.clock = options.clock ?? (() => new Date());
    this.createId = options.createId ?? (() => crypto.randomUUID());
  }

  /** FR-005: name plus the one optional line; type from the entry point, else the default (D-09). */
  async quickCreate(input: {
    readonly type?: string;
    readonly name: string;
    readonly summary?: string;
  }): Promise<Result<EntityRecord, LocalContentError>> {
    const draft = prepareQuickCreate(input, this.#config);
    if (!draft.ok) return draft;
    return this.create(draft.value);
  }

  async create(input: {
    readonly type: string;
    readonly name: string;
    readonly summary?: string;
    readonly description?: string;
    readonly tags?: readonly string[];
    readonly fields?: Readonly<Record<string, string>>;
    /** Omitted: the policy default `gm_only`; the authority re-decides anything else. */
    readonly visibility?: Visibility;
  }): Promise<Result<EntityRecord, LocalContentError>> {
    const type = checkEntityType(input.type, 'create', this.#config);
    if (!type.ok) return type;
    const name = normalizeName(input.name);
    if (!name.ok) return name;
    const summary = checkSummary(input.summary ?? '');
    if (!summary.ok) return summary;
    const description = checkLongText(input.description ?? '');
    if (!description.ok) return description;
    const tags = normalizeTags(input.tags ?? []);
    if (!tags.ok) return tags;
    const fields = normalizeCustomFields(input.fields ?? {});
    if (!fields.ok) return fields;
    const now = this.clock().toISOString();
    const record: EntityRecord = {
      id: this.createId(),
      campaignId: this.actor.campaignId,
      type: input.type,
      name: name.value,
      tags: tags.value,
      metadata: {},
      visibility: input.visibility ?? defaultVisibility(),
      version: 1,
      createdAt: now,
      createdBy: this.actor.userId,
      updatedAt: now,
      updatedBy: this.actor.userId,
      summary: summary.value,
      description: description.value,
      fields: fields.value,
    };
    return this.records.upsert(record, null);
  }

  /** Structured edit (name, type, summary, tags, custom fields); versioned (BR-011). */
  async update(
    id: string,
    changes: {
      readonly type?: string;
      readonly name?: string;
      readonly summary?: string;
      readonly tags?: readonly string[];
      readonly fields?: Readonly<Record<string, string>>;
    },
    expectedVersion: number,
  ): Promise<Result<EntityRecord, LocalContentError>> {
    const current = await this.get(id);
    if (current === undefined) return err('not_found');
    const next = { ...current };
    if (changes.type !== undefined && changes.type !== current.type) {
      const type = checkEntityType(changes.type, 'create', this.#config);
      if (!type.ok) return type;
      next.type = changes.type;
    }
    if (changes.name !== undefined) {
      const name = normalizeName(changes.name);
      if (!name.ok) return name;
      next.name = name.value;
    }
    if (changes.summary !== undefined) {
      const summary = checkSummary(changes.summary);
      if (!summary.ok) return summary;
      next.summary = summary.value;
    }
    if (changes.tags !== undefined) {
      const tags = normalizeTags(changes.tags);
      if (!tags.ok) return tags;
      next.tags = tags.value;
    }
    if (changes.fields !== undefined) {
      const fields = normalizeCustomFields(changes.fields);
      if (!fields.ok) return fields;
      next.fields = fields.value;
    }
    return this.#write(next, expectedVersion);
  }

  /** Saves the description under the current hold (FR-006, D-17). */
  async saveDescription(
    id: string,
    description: string,
    hold: { readonly expectedVersion: number; readonly holdVersion: number },
  ): Promise<Result<EntityRecord, LocalContentError>> {
    const current = await this.get(id);
    if (current === undefined) return err('not_found');
    const text = checkLongText(description);
    if (!text.ok) return text;
    return this.#write(
      { ...current, description: text.value, holdVersion: hold.holdVersion } as EntityRecord,
      hold.expectedVersion,
    );
  }

  /**
   * Feature 17 D-03: reveal or un-reveal as a queued mutation. The device shows feature 04's result
   * at once; the authority recomputes it under `VisibilityService` against `expectedVersion`, the
   * version the GM previewed (D-04).
   */
  async changeVisibility(
    id: string,
    change: EntityVisibilityChange,
    expectedVersion: number,
  ): Promise<Result<EntityRecord, LocalContentError | 'incompatible_visibility'>> {
    if (this.#visibilityRecords === undefined) return err('not_found');
    const current = await this.get(id);
    if (current === undefined) return err('not_found');
    const transition = applyVisibilityChange(current.visibility, change.operation, change.target);
    if (!transition.ok) return err('incompatible_visibility');
    const stored = await this.#visibilityRecords.upsert(
      {
        ...current,
        visibility: transition.visibility,
        visibilityChange: change,
        updatedAt: this.clock().toISOString(),
        updatedBy: this.actor.userId,
      } as EntityRecord,
      expectedVersion,
    );
    return stored.ok ? ok(stripTransport(stored.value)) : stored;
  }

  /** Soft delete (FR-004); relationships stay and render as broken links. */
  async remove(id: string, expectedVersion: number): Promise<Result<void, LocalContentError>> {
    return this.records.softDelete(id, expectedVersion);
  }

  async get(id: string): Promise<EntityRecord | undefined> {
    const found = await this.records.get(id);
    return found.ok && live(found.value) ? stripTransport(found.value) : undefined;
  }

  /** Name-fragment search and filters over the local replica (works with no network). */
  async list(filter: LocalEntityFilter = {}): Promise<EntityRecord[]> {
    const listed = await this.records.list(this.actor.campaignId);
    if (!listed.ok) return [];
    return listed.value
      .filter(live)
      .map(stripTransport)
      .filter((record) => matchesEntityFilter(record, filter))
      .sort(
        (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
      );
  }

  /** FR-016 device API: readable IDs only; unreadable and missing are both absent. */
  async resolve(ids: readonly string[]): Promise<Map<string, EntityRecord>> {
    const resolved = new Map<string, EntityRecord>();
    for (const id of new Set(ids)) {
      const record = await this.get(id);
      if (record !== undefined && record.campaignId === this.actor.campaignId) {
        resolved.set(id, record);
      }
    }
    return resolved;
  }

  async #write(
    next: EntityRecord,
    expectedVersion: number,
  ): Promise<Result<EntityRecord, LocalContentError>> {
    const stored = await this.records.upsert(
      { ...next, updatedAt: this.clock().toISOString(), updatedBy: this.actor.userId },
      expectedVersion,
    );
    return stored.ok ? ok(stripTransport(stored.value)) : stored;
  }
}

/** A player's own notes on the device (BR-007); only the author's replica holds them. */
export class PersonalNoteLocalRepository {
  constructor(
    private readonly records: SyncedRepository<PersonalNoteRecord>,
    private readonly actor: LocalActor,
    private readonly clock: () => Date = () => new Date(),
    private readonly createId: () => string = () => crypto.randomUUID(),
  ) {}

  async create(input: {
    readonly name: string;
    readonly body?: string;
    readonly tags?: readonly string[];
  }): Promise<Result<PersonalNoteRecord, LocalContentError>> {
    const name = normalizeName(input.name);
    if (!name.ok) return name;
    const body = checkLongText(input.body ?? '');
    if (!body.ok) return body;
    const tags = normalizeTags(input.tags ?? []);
    if (!tags.ok) return tags;
    const now = this.clock().toISOString();
    return this.records.upsert(
      {
        id: this.createId(),
        campaignId: this.actor.campaignId,
        type: PERSONAL_NOTE_RECORD_TYPE,
        name: name.value,
        tags: tags.value,
        metadata: {},
        visibility: { mode: 'players', playerIds: [this.actor.userId] },
        version: 1,
        createdAt: now,
        createdBy: this.actor.userId,
        updatedAt: now,
        updatedBy: this.actor.userId,
        authorUserId: this.actor.userId,
        body: body.value,
      },
      null,
    );
  }

  async update(
    id: string,
    changes: { readonly name?: string; readonly tags?: readonly string[] },
    expectedVersion: number,
  ): Promise<Result<PersonalNoteRecord, LocalContentError>> {
    const current = await this.get(id);
    if (current === undefined) return err('not_found');
    const next = { ...current };
    if (changes.name !== undefined) {
      const name = normalizeName(changes.name);
      if (!name.ok) return name;
      next.name = name.value;
    }
    if (changes.tags !== undefined) {
      const tags = normalizeTags(changes.tags);
      if (!tags.ok) return tags;
      next.tags = tags.value;
    }
    return this.#write(next, expectedVersion);
  }

  async saveBody(
    id: string,
    body: string,
    hold: { readonly expectedVersion: number; readonly holdVersion: number },
  ): Promise<Result<PersonalNoteRecord, LocalContentError>> {
    const current = await this.get(id);
    if (current === undefined) return err('not_found');
    const text = checkLongText(body);
    if (!text.ok) return text;
    return this.#write(
      { ...current, body: text.value, holdVersion: hold.holdVersion } as PersonalNoteRecord,
      hold.expectedVersion,
    );
  }

  async remove(id: string, expectedVersion: number): Promise<Result<void, LocalContentError>> {
    return this.records.softDelete(id, expectedVersion);
  }

  async get(id: string): Promise<PersonalNoteRecord | undefined> {
    const found = await this.records.get(id);
    return found.ok && live(found.value) ? stripTransport(found.value) : undefined;
  }

  async list(): Promise<PersonalNoteRecord[]> {
    const listed = await this.records.list(this.actor.campaignId);
    return listed.ok ? listed.value.filter(live).map(stripTransport) : [];
  }

  async #write(
    next: PersonalNoteRecord,
    expectedVersion: number,
  ): Promise<Result<PersonalNoteRecord, LocalContentError>> {
    const stored = await this.records.upsert(
      { ...next, updatedAt: this.clock().toISOString(), updatedBy: this.actor.userId },
      expectedVersion,
    );
    return stored.ok ? ok(stripTransport(stored.value)) : stored;
  }
}

/**
 * Device-side links (task 09): validated with the same pure rules as the authority against the
 * locally visible endpoints (both live in the local replica, kind configured, no self-link, no
 * live duplicate, Visibility within the endpoints' intersection). The authority re-checks under
 * its endpoint locks. Insert and tombstone only; a kind change is unlink plus link.
 */
export class RelationshipLocalRepository {
  readonly #config: ContentConfiguration;

  constructor(
    private readonly records: SyncedRepository<RelationshipRecord>,
    private readonly entities: Pick<EntityLocalRepository, 'get'>,
    private readonly actor: LocalActor,
    options: {
      readonly configuration?: ContentConfiguration;
      readonly clock?: () => Date;
      readonly createId?: () => string;
    } = {},
  ) {
    this.#config = options.configuration ?? CONTENT_CONFIGURATION;
    this.#clock = options.clock ?? (() => new Date());
    this.#createId = options.createId ?? (() => crypto.randomUUID());
  }

  readonly #clock: () => Date;
  readonly #createId: () => string;

  async link(input: {
    readonly sourceEntityId: string;
    readonly targetEntityId: string;
    readonly kind: string;
    /** Omitted: `gm_only` (BR-005), which every pair of endpoints admits. */
    readonly visibility?: Visibility;
  }): Promise<Result<RelationshipRecord, LocalRelationshipError>> {
    const kind = checkRelationshipKind(input.kind, this.#config);
    if (!kind.ok) return kind;
    if (input.sourceEntityId === input.targetEntityId) return err('self_link');
    const source = await this.entities.get(input.sourceEntityId);
    const target = await this.entities.get(input.targetEntityId);
    if (source === undefined || target === undefined) return err('invalid_endpoint');
    const visibility = input.visibility ?? relationshipDefaultVisibility();
    if (!isWithin(visibility, source.visibility, target.visibility)) {
      return err('incompatible_visibility');
    }
    const existing = await this.listFor(input.sourceEntityId);
    if (
      existing.some(
        (record) =>
          record.sourceEntityId === input.sourceEntityId &&
          record.targetEntityId === input.targetEntityId &&
          record.kind === kind.value.id,
      )
    ) {
      return err('duplicate_relationship');
    }
    const now = this.#clock().toISOString();
    return this.records.upsert(
      {
        id: this.#createId(),
        campaignId: this.actor.campaignId,
        type: RELATIONSHIP_RECORD_TYPE,
        name: kind.value.label,
        tags: [],
        metadata: {},
        visibility,
        version: 1,
        createdAt: now,
        createdBy: this.actor.userId,
        updatedAt: now,
        updatedBy: this.actor.userId,
        sourceEntityId: input.sourceEntityId,
        targetEntityId: input.targetEntityId,
        kind: kind.value.id,
      },
      null,
    );
  }

  async unlink(id: string, expectedVersion: number): Promise<Result<void, LocalContentError>> {
    return this.records.softDelete(id, expectedVersion);
  }

  /** Every live link on the device (endpoints may be tombstones: broken links). */
  async listAll(): Promise<RelationshipRecord[]> {
    const listed = await this.records.list(this.actor.campaignId);
    return listed.ok ? listed.value.filter(live) : [];
  }

  /** Live links where the entity is source or target (endpoints may be tombstones: broken). */
  async listFor(entityId: string): Promise<RelationshipRecord[]> {
    const listed = await this.records.list(this.actor.campaignId);
    if (!listed.ok) return [];
    return listed.value.filter(
      (record) =>
        live(record) && (record.sourceEntityId === entityId || record.targetEntityId === entityId),
    );
  }
}

export type LocalRelationshipError =
  | LocalContentError
  | 'self_link'
  | 'invalid_endpoint'
  | 'incompatible_visibility'
  | 'duplicate_relationship';

function relationshipDefaultVisibility(): Visibility {
  const value = ENTITY_RELATIONSHIP_POLICY.defaultVisibility;
  return value === 'explicit' ? { mode: 'gm_only' } : value;
}
