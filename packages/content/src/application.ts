import {
  type Capability,
  DEFAULT_REVEAL_TARGETS,
  type Decision,
  MAX_VISIBILITY_TARGETS,
  normalizeVisibility,
  type ResourceFacts,
  type ResourcePolicy,
  sameVisibility,
} from '@rpg/authorization';
import {
  type ActorRef,
  check,
  err,
  Id,
  Metadata,
  ok,
  type Result,
  Version,
  type Visibility,
} from '@rpg/contracts';
import { CONTENT_AUDIT_ACTIONS } from './audit-actions.ts';
import {
  type ContentRuleError,
  checkEntityType,
  checkLongText,
  checkRelationshipKind,
  checkSummary,
  isWithin,
  normalizeCustomFields,
  normalizeName,
  normalizeTags,
} from './domain.ts';
import type {
  CompareAndSetResult,
  ContentTransaction,
  EntityChanges,
  PersonalNoteChanges,
  PostgresEntityRepository,
  PostgresPersonalNoteRepository,
  PostgresRelationshipRepository,
} from './infra/postgres/repository.ts';
import {
  CAMPAIGN_ENTITY_CLASS,
  CAMPAIGN_ENTITY_POLICY,
  ENTITY_RELATIONSHIP_CLASS,
  ENTITY_RELATIONSHIP_POLICY,
  PERSONAL_NOTE_CLASS,
} from './policies.ts';
import type { EntityRecord, PersonalNoteRecord, RelationshipRecord } from './schemas.ts';
import { CONTENT_CONFIGURATION, type ContentConfiguration } from './types.ts';

/**
 * Feature 16 application services (`_techspec.md` "Mutation Appliers" steps 1–3, 6–7). One
 * service per class validates with the pure rules (`domain.ts`: D-01, D-11, D-18), decides through
 * feature 04 (`AuthorizationService.decide`, never a role read here), and writes through the
 * PostgreSQL repository inside one transaction: compare-and-set on `version`, then the caller's
 * audit hook on the same transaction, once, after the write matched (feature 06 task 02 pattern).
 *
 * The Actor is always the resolved `ActorRef` (identity), never input. Visibility on create is the
 * policy default or an explicit value that also needs the `reveal` decision; updates never change
 * Visibility (feature 04 `VisibilityService` owns that). Long-text holds (`description`, `body`)
 * need the uploading session, so the applier supplies them as a guard (B-2, task 06).
 */

/** `AuthorizationService` (feature 04), structurally. */
export interface ContentDecider {
  decide(actor: ActorRef, capability: Capability, facts: ResourceFacts): Decision;
}

/** Current campaign membership of a reveal target (identity `ActorResolver`, any role). */
export interface ContentTargetMembers {
  isMember(campaignId: string, userId: string): Promise<boolean>;
}

/** Feature 06 target visibility snapshot (structural `TargetVisibilitySnapshot`). */
export interface ContentAuditSnapshot {
  readonly visibility: Visibility;
  readonly authorUserId?: string;
}

/**
 * Server-authored audit content. The caller binds campaign, target ID, actor, and origin
 * (mutation) ID; `before`/`after` never hold long text, custom-field labels or values.
 */
export interface ContentAuditEvent {
  readonly action: string;
  readonly targetType: string;
  readonly before?: Record<string, unknown>;
  readonly after?: Record<string, unknown>;
  readonly targetVisibility: ContentAuditSnapshot;
}

/**
 * Called once inside the write transaction after the compare-and-set matched (structurally the
 * feature 03 `MutationAuditHook` with an authored event). A throw rolls the write back.
 */
export type ContentAuditHook = (
  transaction: ContentTransaction,
  event: ContentAuditEvent,
) => Promise<void>;

/**
 * Asked inside the write transaction, before the record's row is touched (lock order: hold row,
 * then record), when a long-text change is written; `false` rejects it as `hold_required`.
 */
export type LongTextGuard = (
  fieldPath: string,
  transaction: ContentTransaction,
) => Promise<boolean>;

export type ContentInvalidReason =
  | ContentRuleError
  | 'invalid_identifier'
  | 'invalid_version'
  | 'invalid_metadata'
  | 'invalid_visibility'
  | 'target_not_member'
  | 'visibility_change_not_allowed'
  | 'self_link'
  | 'invalid_endpoint'
  | 'incompatible_visibility'
  | 'duplicate_relationship';

export type ContentWriteFailure<T> =
  | { readonly code: 'invalid_payload'; readonly reason: ContentInvalidReason }
  /** Missing, foreign, denied, or an existing id: one indistinguishable answer. */
  | { readonly code: 'not_found_or_forbidden' }
  /** A tombstone the actor may otherwise update; it is never edited (BDD "Deletion"). */
  | { readonly code: 'record_deleted' }
  | { readonly code: 'hold_required' }
  /** Stale `expectedVersion`; `current` is the authority record (the actor may read it). */
  | { readonly code: 'version_conflict'; readonly current: T };

export type ContentWriteResult<T> = Result<T, ContentWriteFailure<T>>;

export interface WriteOptions {
  readonly audit?: ContentAuditHook;
  readonly longText?: LongTextGuard;
}

export interface EntityCreateInput {
  readonly campaignId: string;
  readonly id: string;
  readonly type: unknown;
  readonly name: unknown;
  readonly summary?: unknown;
  readonly description?: unknown;
  readonly tags?: unknown;
  readonly fields?: unknown;
  readonly metadata?: unknown;
  /** Omitted: the policy default (`gm_only`, FR-010). */
  readonly visibility?: Visibility;
}

export interface EntityUpdateInput {
  readonly campaignId: string;
  readonly id: string;
  readonly expectedVersion: number;
  /** Omitted fields are unchanged. */
  readonly changes: {
    readonly type?: unknown;
    readonly name?: unknown;
    readonly summary?: unknown;
    readonly description?: unknown;
    readonly tags?: unknown;
    readonly fields?: unknown;
    readonly metadata?: unknown;
  };
  /** When present it must equal the stored Visibility (updates never change it). */
  readonly visibility?: Visibility;
}

export interface TombstoneInput {
  readonly campaignId: string;
  readonly id: string;
  readonly expectedVersion: number;
}

export interface PersonalNoteCreateInput {
  readonly campaignId: string;
  readonly id: string;
  readonly name: unknown;
  readonly body?: unknown;
  readonly tags?: unknown;
  readonly metadata?: unknown;
}

export interface PersonalNoteUpdateInput {
  readonly campaignId: string;
  readonly id: string;
  readonly expectedVersion: number;
  readonly changes: {
    readonly name?: unknown;
    readonly body?: unknown;
    readonly tags?: unknown;
    readonly metadata?: unknown;
  };
}

const HIDDEN = { ok: false, error: { code: 'not_found_or_forbidden' } } as const;
const DELETED = { ok: false, error: { code: 'record_deleted' } } as const;
const HOLD_REQUIRED = { ok: false, error: { code: 'hold_required' } } as const;

function invalid(reason: ContentInvalidReason) {
  return { ok: false, error: { code: 'invalid_payload', reason } } as const;
}

type Checked<T> = Result<T, ContentInvalidReason>;

function optional<T>(
  value: unknown,
  rule: (value: unknown) => Result<T, ContentRuleError>,
): Checked<T | undefined> {
  return value === undefined ? ok(undefined) : rule(value);
}

function checkMetadata(value: unknown): Checked<Record<string, unknown>> {
  return check(Metadata, value) ? ok(value) : err('invalid_metadata');
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validIds(campaignId: string, id: string): boolean {
  return check(Id, campaignId) && check(Id, id);
}

function policyDefault(policy: ResourcePolicy): Visibility {
  return policy.defaultVisibility === 'explicit' ? { mode: 'gm_only' } : policy.defaultVisibility;
}

function entityFacts(record: Pick<EntityRecord, 'campaignId' | 'id' | 'visibility' | 'version'>) {
  return {
    campaignId: record.campaignId,
    resourceClass: CAMPAIGN_ENTITY_CLASS,
    resourceId: record.id,
    visibility: record.visibility,
    version: record.version,
  } satisfies ResourceFacts;
}

function noteFacts(
  record: Pick<PersonalNoteRecord, 'campaignId' | 'id' | 'visibility' | 'version' | 'authorUserId'>,
) {
  return {
    campaignId: record.campaignId,
    resourceClass: PERSONAL_NOTE_CLASS,
    resourceId: record.id,
    visibility: record.visibility,
    version: record.version,
    authorUserId: record.authorUserId,
  } satisfies ResourceFacts;
}

function casFailure<T>(result: CompareAndSetResult<T> & { ok: false }): ContentWriteResult<T> {
  switch (result.reason) {
    case 'deleted':
      return DELETED;
    case 'version_conflict':
      return { ok: false, error: { code: 'version_conflict', current: result.current } };
    default:
      return HIDDEN;
  }
}

/** The structured values an entity audit payload may carry (never long text or field content). */
function entityAuditValue(record: EntityRecord) {
  const changed = [
    ...(record.description === '' ? [] : ['description']),
    ...(Object.keys(record.fields).length === 0 ? [] : ['fields']),
    ...(Object.keys(record.metadata).length === 0 ? [] : ['metadata']),
  ];
  return {
    type: record.type,
    name: record.name,
    summary: record.summary,
    tags: [...record.tags],
    ...(changed.length === 0 ? {} : { changed }),
  };
}

const RECORDED_ENTITY_FIELDS = ['type', 'name', 'summary', 'tags'] as const;
const UNRECORDED_ENTITY_FIELDS = ['description', 'fields', 'metadata'] as const;

/** `before`/`after` of an entity update: changed structured fields and `changed` names only. */
function entityUpdateAudit(before: EntityRecord, after: EntityRecord) {
  const old: Record<string, unknown> = {};
  const next: Record<string, unknown> = {};
  for (const field of RECORDED_ENTITY_FIELDS) {
    if (!sameJson(before[field], after[field])) {
      old[field] = before[field];
      next[field] = after[field];
    }
  }
  // The type is kept so the event names what changed even when only text changed.
  next.type ??= after.type;
  const changed = UNRECORDED_ENTITY_FIELDS.filter(
    (field) => !sameJson(before[field], after[field]),
  );
  if (changed.length > 0) next.changed = changed;
  return { before: old, after: next };
}

/** Same target rules as feature 04 `VisibilityService` reveal: `players` of current members. */
async function targetProblem(
  policy: ResourcePolicy,
  members: ContentTargetMembers | undefined,
  campaignId: string,
  visibility: Visibility,
): Promise<ContentInvalidReason | undefined> {
  if (visibility.mode === 'everyone') return undefined;
  if (visibility.mode !== 'players') return 'invalid_visibility';
  if (!(policy.revealTargets ?? DEFAULT_REVEAL_TARGETS).includes('players')) {
    return 'invalid_visibility';
  }
  const ids = visibility.playerIds;
  if (ids.length > MAX_VISIBILITY_TARGETS || !ids.every((id) => check(Id, id))) {
    return 'invalid_visibility';
  }
  if (members === undefined) return 'target_not_member';
  const resolved = await Promise.all(ids.map((id) => members.isMember(campaignId, id)));
  return resolved.every(Boolean) ? undefined : 'target_not_member';
}

export interface EntityServiceDependencies {
  readonly entities: PostgresEntityRepository;
  readonly decider: ContentDecider;
  /** Required for an explicit `players` Visibility on create; absent means none is accepted. */
  readonly members?: ContentTargetMembers;
  readonly configuration?: ContentConfiguration;
  readonly policy?: ResourcePolicy;
}

/** Campaign entities of every configured type (class `campaign_entity`). */
export class EntityService {
  readonly #entities: PostgresEntityRepository;
  readonly #decider: ContentDecider;
  readonly #members: ContentTargetMembers | undefined;
  readonly #config: ContentConfiguration;
  readonly #policy: ResourcePolicy;

  constructor(deps: EntityServiceDependencies) {
    this.#entities = deps.entities;
    this.#decider = deps.decider;
    this.#members = deps.members;
    this.#config = deps.configuration ?? CONTENT_CONFIGURATION;
    this.#policy = deps.policy ?? CAMPAIGN_ENTITY_POLICY;
  }

  async create(
    actor: ActorRef,
    input: EntityCreateInput,
    options: WriteOptions = {},
  ): Promise<ContentWriteResult<EntityRecord>> {
    if (!validIds(input.campaignId, input.id)) return invalid('invalid_identifier');
    const type = checkEntityType(input.type, 'create', this.#config);
    if (!type.ok) return invalid(type.error);
    const name = normalizeName(input.name);
    if (!name.ok) return invalid(name.error);
    const summary = checkSummary(input.summary ?? '');
    if (!summary.ok) return invalid(summary.error);
    const description = checkLongText(input.description ?? '');
    if (!description.ok) return invalid(description.error);
    const tags = normalizeTags(input.tags ?? []);
    if (!tags.ok) return invalid(tags.error);
    const fields = normalizeCustomFields(input.fields ?? {});
    if (!fields.ok) return invalid(fields.error);
    const metadata = checkMetadata(input.metadata ?? {});
    if (!metadata.ok) return invalid(metadata.error);

    const fallback = policyDefault(this.#policy);
    const visibility =
      input.visibility === undefined ? fallback : normalizeVisibility(input.visibility);
    // Party targeting fails closed in P0 (feature 04): not a storable choice at create.
    if (visibility.mode === 'party') return invalid('invalid_visibility');
    const facts = entityFacts({
      campaignId: input.campaignId,
      id: input.id,
      visibility,
      version: 1,
    });
    if (!this.#decider.decide(actor, 'create', facts).allowed) return HIDDEN;
    if (!sameVisibility(visibility, fallback)) {
      // An explicit non-default Visibility is a reveal at birth.
      if (!this.#decider.decide(actor, 'reveal', facts).allowed) return HIDDEN;
      const problem = await targetProblem(
        this.#policy,
        this.#members,
        input.campaignId,
        visibility,
      );
      if (problem !== undefined) return invalid(problem);
    }

    return this.#entities.transaction(
      async (transaction): Promise<ContentWriteResult<EntityRecord>> => {
        const created = await this.#entities.insert(transaction, {
          id: input.id,
          campaignId: input.campaignId,
          type: String(input.type),
          name: name.value,
          summary: summary.value,
          description: description.value,
          tags: tags.value,
          fields: fields.value,
          metadata: metadata.value,
          visibility,
          actorUserId: actor.userId,
        });
        // An existing id (any campaign) is never overwritten nor confirmed.
        if (!created.ok) return HIDDEN;
        await options.audit?.(transaction, {
          action: CONTENT_AUDIT_ACTIONS.created,
          targetType: CAMPAIGN_ENTITY_CLASS,
          after: entityAuditValue(created.record),
          targetVisibility: { visibility: created.record.visibility },
        });
        return ok(created.record);
      },
    );
  }

  /**
   * Feature 17: the stored record as the actor may read it (a conflict response for a queued reveal);
   * hidden and missing are both `undefined`.
   */
  async readable(
    actor: ActorRef,
    campaignId: string,
    id: string,
  ): Promise<EntityRecord | undefined> {
    if (!validIds(campaignId, id)) return undefined;
    const current = await this.#entities.get(campaignId, id, { includeDeleted: true });
    if (current === undefined) return undefined;
    return this.#decider.decide(actor, 'read', entityFacts(current)).allowed ? current : undefined;
  }

  async update(
    actor: ActorRef,
    input: EntityUpdateInput,
    options: WriteOptions = {},
  ): Promise<ContentWriteResult<EntityRecord>> {
    if (!validIds(input.campaignId, input.id)) return invalid('invalid_identifier');
    if (!check(Version, input.expectedVersion)) return invalid('invalid_version');
    const prepared = this.#prepareChanges(input.changes);
    if (!prepared.ok) return invalid(prepared.error);

    const current = await this.#entities.get(input.campaignId, input.id, { includeDeleted: true });
    if (current === undefined) return HIDDEN;
    if (!this.#decider.decide(actor, 'update', entityFacts(current)).allowed) return HIDDEN;
    if (current.deletedAt !== undefined) return DELETED;
    if (current.version !== input.expectedVersion) {
      return { ok: false, error: { code: 'version_conflict', current } };
    }
    const changes = prepared.value;
    if (changes.type !== undefined && changes.type !== current.type) {
      // Changing to another type needs a configured, enabled one; keeping a removed type is fine.
      const next = checkEntityType(changes.type, 'create', this.#config);
      if (!next.ok) return invalid(next.error);
    }
    if (input.visibility !== undefined && !sameVisibility(input.visibility, current.visibility)) {
      return invalid('visibility_change_not_allowed');
    }
    const longTextChanged =
      changes.description !== undefined && changes.description !== current.description;

    return this.#entities.transaction(
      async (transaction): Promise<ContentWriteResult<EntityRecord>> => {
        if (
          longTextChanged &&
          (options.longText === undefined || !(await options.longText('description', transaction)))
        ) {
          return HOLD_REQUIRED;
        }
        const updated = await this.#entities.update(transaction, {
          campaignId: input.campaignId,
          id: input.id,
          expectedVersion: input.expectedVersion,
          actorUserId: actor.userId,
          changes,
        });
        if (!updated.ok) return casFailure(updated);
        const audit = entityUpdateAudit(current, updated.record);
        await options.audit?.(transaction, {
          action: CONTENT_AUDIT_ACTIONS.updated,
          targetType: CAMPAIGN_ENTITY_CLASS,
          before: audit.before,
          after: audit.after,
          targetVisibility: { visibility: updated.record.visibility },
        });
        return ok(updated.record);
      },
    );
  }

  /** Soft delete (FR-004): sets `deletedAt`, increments the version, leaves relationships. */
  async tombstone(
    actor: ActorRef,
    input: TombstoneInput,
    options: Pick<WriteOptions, 'audit'> = {},
  ): Promise<ContentWriteResult<EntityRecord>> {
    if (!validIds(input.campaignId, input.id)) return invalid('invalid_identifier');
    if (!check(Version, input.expectedVersion)) return invalid('invalid_version');
    const current = await this.#entities.get(input.campaignId, input.id, { includeDeleted: true });
    if (current === undefined) return HIDDEN;
    if (!this.#decider.decide(actor, 'delete', entityFacts(current)).allowed) return HIDDEN;
    if (current.deletedAt !== undefined) return DELETED;
    if (current.version !== input.expectedVersion) {
      return { ok: false, error: { code: 'version_conflict', current } };
    }
    return this.#entities.transaction(
      async (transaction): Promise<ContentWriteResult<EntityRecord>> => {
        const deleted = await this.#entities.tombstone(transaction, {
          campaignId: input.campaignId,
          id: input.id,
          expectedVersion: input.expectedVersion,
          actorUserId: actor.userId,
        });
        if (!deleted.ok) return casFailure(deleted);
        await options.audit?.(transaction, {
          action: CONTENT_AUDIT_ACTIONS.deleted,
          targetType: CAMPAIGN_ENTITY_CLASS,
          before: { type: current.type, name: current.name },
          targetVisibility: { visibility: current.visibility },
        });
        return ok(deleted.record);
      },
    );
  }

  #prepareChanges(input: EntityUpdateInput['changes']): Checked<EntityChanges> {
    const type =
      input.type === undefined
        ? ok(undefined)
        : checkEntityType(input.type, 'existing', this.#config);
    if (!type.ok) return type;
    const name = optional(input.name, normalizeName);
    if (!name.ok) return name;
    const summary = optional(input.summary, checkSummary);
    if (!summary.ok) return summary;
    const description = optional(input.description, checkLongText);
    if (!description.ok) return description;
    const tags = optional(input.tags, normalizeTags);
    if (!tags.ok) return tags;
    const fields = optional(input.fields, normalizeCustomFields);
    if (!fields.ok) return fields;
    const metadata = input.metadata === undefined ? ok(undefined) : checkMetadata(input.metadata);
    if (!metadata.ok) return metadata;
    return ok({
      ...(input.type === undefined ? {} : { type: String(input.type) }),
      ...(name.value === undefined ? {} : { name: name.value }),
      ...(summary.value === undefined ? {} : { summary: summary.value }),
      ...(description.value === undefined ? {} : { description: description.value }),
      ...(tags.value === undefined ? {} : { tags: tags.value }),
      ...(fields.value === undefined ? {} : { fields: fields.value }),
      ...(metadata.value === undefined ? {} : { metadata: metadata.value }),
    });
  }
}

/** Snapshot of every personal-note event: the author only (feature 06 also applies the rule). */
function noteSnapshot(authorUserId: string): ContentAuditSnapshot {
  return { visibility: { mode: 'players', playerIds: [authorUserId] }, authorUserId };
}

function noteAuditValue(record: PersonalNoteRecord) {
  const changed = [
    ...(record.body === '' ? [] : ['body']),
    ...(Object.keys(record.metadata).length === 0 ? [] : ['metadata']),
  ];
  return {
    name: record.name,
    tags: [...record.tags],
    ...(changed.length === 0 ? {} : { changed }),
  };
}

function noteUpdateAudit(before: PersonalNoteRecord, after: PersonalNoteRecord) {
  const old: Record<string, unknown> = {};
  const next: Record<string, unknown> = {};
  for (const field of ['name', 'tags'] as const) {
    if (!sameJson(before[field], after[field])) {
      old[field] = before[field];
      next[field] = after[field];
    }
  }
  const changed = (['body', 'metadata'] as const).filter(
    (field) => !sameJson(before[field], after[field]),
  );
  if (changed.length > 0) next.changed = changed;
  return { before: old, after: next };
}

export interface PersonalNoteServiceDependencies {
  readonly notes: PostgresPersonalNoteRepository;
  readonly decider: ContentDecider;
}

/**
 * A player's private notes (class `personal_note`, BR-007, D-06). The author is the actor;
 * Visibility is fixed `players:[author]` by the repository and the CHECK.
 */
export class PersonalNoteService {
  readonly #notes: PostgresPersonalNoteRepository;
  readonly #decider: ContentDecider;

  constructor(deps: PersonalNoteServiceDependencies) {
    this.#notes = deps.notes;
    this.#decider = deps.decider;
  }

  async create(
    actor: ActorRef,
    input: PersonalNoteCreateInput,
    options: Pick<WriteOptions, 'audit'> = {},
  ): Promise<ContentWriteResult<PersonalNoteRecord>> {
    if (!validIds(input.campaignId, input.id)) return invalid('invalid_identifier');
    const name = normalizeName(input.name);
    if (!name.ok) return invalid(name.error);
    const body = checkLongText(input.body ?? '');
    if (!body.ok) return invalid(body.error);
    const tags = normalizeTags(input.tags ?? []);
    if (!tags.ok) return invalid(tags.error);
    const metadata = checkMetadata(input.metadata ?? {});
    if (!metadata.ok) return invalid(metadata.error);
    const facts = noteFacts({
      campaignId: input.campaignId,
      id: input.id,
      visibility: { mode: 'players', playerIds: [actor.userId] },
      version: 1,
      authorUserId: actor.userId,
    });
    if (!this.#decider.decide(actor, 'create', facts).allowed) return HIDDEN;

    return this.#notes.transaction(
      async (transaction): Promise<ContentWriteResult<PersonalNoteRecord>> => {
        const created = await this.#notes.insert(transaction, {
          id: input.id,
          campaignId: input.campaignId,
          authorUserId: actor.userId,
          name: name.value,
          body: body.value,
          tags: tags.value,
          metadata: metadata.value,
        });
        if (!created.ok) return HIDDEN;
        await options.audit?.(transaction, {
          action: CONTENT_AUDIT_ACTIONS.personalNoteCreated,
          targetType: PERSONAL_NOTE_CLASS,
          after: noteAuditValue(created.record),
          targetVisibility: noteSnapshot(created.record.authorUserId),
        });
        return ok(created.record);
      },
    );
  }

  async update(
    actor: ActorRef,
    input: PersonalNoteUpdateInput,
    options: WriteOptions = {},
  ): Promise<ContentWriteResult<PersonalNoteRecord>> {
    if (!validIds(input.campaignId, input.id)) return invalid('invalid_identifier');
    if (!check(Version, input.expectedVersion)) return invalid('invalid_version');
    const name = optional(input.changes.name, normalizeName);
    if (!name.ok) return invalid(name.error);
    const body = optional(input.changes.body, checkLongText);
    if (!body.ok) return invalid(body.error);
    const tags = optional(input.changes.tags, normalizeTags);
    if (!tags.ok) return invalid(tags.error);
    const metadata =
      input.changes.metadata === undefined ? ok(undefined) : checkMetadata(input.changes.metadata);
    if (!metadata.ok) return invalid(metadata.error);

    const current = await this.#notes.get(input.campaignId, input.id, { includeDeleted: true });
    if (current === undefined) return HIDDEN;
    if (!this.#decider.decide(actor, 'update', noteFacts(current)).allowed) return HIDDEN;
    if (current.deletedAt !== undefined) return DELETED;
    if (current.version !== input.expectedVersion) {
      return { ok: false, error: { code: 'version_conflict', current } };
    }
    const longTextChanged = body.value !== undefined && body.value !== current.body;
    const changes: PersonalNoteChanges = {
      ...(name.value === undefined ? {} : { name: name.value }),
      ...(body.value === undefined ? {} : { body: body.value }),
      ...(tags.value === undefined ? {} : { tags: tags.value }),
      ...(metadata.value === undefined ? {} : { metadata: metadata.value }),
    };

    return this.#notes.transaction(
      async (transaction): Promise<ContentWriteResult<PersonalNoteRecord>> => {
        if (
          longTextChanged &&
          (options.longText === undefined || !(await options.longText('body', transaction)))
        ) {
          return HOLD_REQUIRED;
        }
        const updated = await this.#notes.update(transaction, {
          campaignId: input.campaignId,
          id: input.id,
          expectedVersion: input.expectedVersion,
          actorUserId: actor.userId,
          changes,
        });
        if (!updated.ok) return casFailure(updated);
        const audit = noteUpdateAudit(current, updated.record);
        await options.audit?.(transaction, {
          action: CONTENT_AUDIT_ACTIONS.personalNoteUpdated,
          targetType: PERSONAL_NOTE_CLASS,
          before: audit.before,
          after: audit.after,
          targetVisibility: noteSnapshot(current.authorUserId),
        });
        return ok(updated.record);
      },
    );
  }

  async tombstone(
    actor: ActorRef,
    input: TombstoneInput,
    options: Pick<WriteOptions, 'audit'> = {},
  ): Promise<ContentWriteResult<PersonalNoteRecord>> {
    if (!validIds(input.campaignId, input.id)) return invalid('invalid_identifier');
    if (!check(Version, input.expectedVersion)) return invalid('invalid_version');
    const current = await this.#notes.get(input.campaignId, input.id, { includeDeleted: true });
    if (current === undefined) return HIDDEN;
    if (!this.#decider.decide(actor, 'delete', noteFacts(current)).allowed) return HIDDEN;
    if (current.deletedAt !== undefined) return DELETED;
    if (current.version !== input.expectedVersion) {
      return { ok: false, error: { code: 'version_conflict', current } };
    }
    return this.#notes.transaction(
      async (transaction): Promise<ContentWriteResult<PersonalNoteRecord>> => {
        const deleted = await this.#notes.tombstone(transaction, {
          campaignId: input.campaignId,
          id: input.id,
          expectedVersion: input.expectedVersion,
          actorUserId: actor.userId,
        });
        if (!deleted.ok) return casFailure(deleted);
        await options.audit?.(transaction, {
          action: CONTENT_AUDIT_ACTIONS.personalNoteDeleted,
          targetType: PERSONAL_NOTE_CLASS,
          before: { name: current.name },
          targetVisibility: noteSnapshot(current.authorUserId),
        });
        return ok(deleted.record);
      },
    );
  }
}

export interface RelationshipCreateInput {
  readonly campaignId: string;
  readonly id: string;
  readonly sourceEntityId: string;
  readonly targetEntityId: string;
  readonly kind: unknown;
  /** Omitted: the policy default (`gm_only`, BR-005). */
  readonly visibility?: Visibility;
}

function relationshipFacts(
  record: Pick<RelationshipRecord, 'campaignId' | 'id' | 'visibility' | 'version'>,
) {
  return {
    campaignId: record.campaignId,
    resourceClass: ENTITY_RELATIONSHIP_CLASS,
    resourceId: record.id,
    visibility: record.visibility,
    version: record.version,
  } satisfies ResourceFacts;
}

function relationshipAuditValue(record: RelationshipRecord) {
  return {
    kind: record.kind,
    sourceEntityId: record.sourceEntityId,
    targetEntityId: record.targetEntityId,
  };
}

export interface RelationshipServiceDependencies {
  readonly entities: PostgresEntityRepository;
  readonly relationships: PostgresRelationshipRepository;
  readonly decider: ContentDecider;
  readonly members?: ContentTargetMembers;
  readonly configuration?: ContentConfiguration;
  readonly policy?: ResourcePolicy;
}

/**
 * Typed relationships (task 09, FR-008): insert and tombstone only; a kind change is a tombstone
 * plus a new link. On create both endpoints must be live campaign entities (personal notes are
 * never endpoints, D-15), locked `FOR SHARE` in ascending id order before the bound check, so a
 * concurrent endpoint narrowing (which takes the entity row first) serializes with it and no
 * committed link is ever wider than its endpoints (D-07 option A).
 */
export class RelationshipService {
  readonly #entities: PostgresEntityRepository;
  readonly #relationships: PostgresRelationshipRepository;
  readonly #decider: ContentDecider;
  readonly #members: ContentTargetMembers | undefined;
  readonly #config: ContentConfiguration;
  readonly #policy: ResourcePolicy;

  constructor(deps: RelationshipServiceDependencies) {
    this.#entities = deps.entities;
    this.#relationships = deps.relationships;
    this.#decider = deps.decider;
    this.#members = deps.members;
    this.#config = deps.configuration ?? CONTENT_CONFIGURATION;
    this.#policy = deps.policy ?? ENTITY_RELATIONSHIP_POLICY;
  }

  async create(
    actor: ActorRef,
    input: RelationshipCreateInput,
    options: Pick<WriteOptions, 'audit'> = {},
  ): Promise<ContentWriteResult<RelationshipRecord>> {
    if (
      !validIds(input.campaignId, input.id) ||
      !check(Id, input.sourceEntityId) ||
      !check(Id, input.targetEntityId)
    ) {
      return invalid('invalid_identifier');
    }
    const kind = checkRelationshipKind(input.kind, this.#config);
    if (!kind.ok) return invalid(kind.error);
    if (input.sourceEntityId === input.targetEntityId) return invalid('self_link');
    const fallback = policyDefault(this.#policy);
    const visibility =
      input.visibility === undefined ? fallback : normalizeVisibility(input.visibility);
    if (visibility.mode === 'party') return invalid('invalid_visibility');
    const facts = relationshipFacts({
      campaignId: input.campaignId,
      id: input.id,
      visibility,
      version: 1,
    });
    if (!this.#decider.decide(actor, 'create', facts).allowed) return HIDDEN;
    if (!sameVisibility(visibility, fallback)) {
      if (!this.#decider.decide(actor, 'reveal', facts).allowed) return HIDDEN;
      const problem = await targetProblem(
        this.#policy,
        this.#members,
        input.campaignId,
        visibility,
      );
      if (problem !== undefined) return invalid(problem);
    }

    return this.#relationships.transaction(
      async (transaction): Promise<ContentWriteResult<RelationshipRecord>> => {
        const endpoints = new Map<string, EntityRecord>();
        for (const id of [input.sourceEntityId, input.targetEntityId].sort()) {
          const endpoint = await this.#entities.get(input.campaignId, id, {
            lock: 'share',
            executor: transaction,
          });
          if (endpoint !== undefined) endpoints.set(id, endpoint);
        }
        const source = endpoints.get(input.sourceEntityId);
        const target = endpoints.get(input.targetEntityId);
        // Missing, another campaign's, tombstoned, or not an entity at all (a personal note).
        if (source === undefined || target === undefined) return invalid('invalid_endpoint');
        if (!isWithin(visibility, source.visibility, target.visibility)) {
          return invalid('incompatible_visibility');
        }
        const created = await this.#relationships.insert(transaction, {
          id: input.id,
          campaignId: input.campaignId,
          sourceEntityId: input.sourceEntityId,
          targetEntityId: input.targetEntityId,
          kind: kind.value.id,
          visibility,
          actorUserId: actor.userId,
        });
        if (!created.ok) {
          return created.reason === 'duplicate' ? invalid('duplicate_relationship') : HIDDEN;
        }
        await options.audit?.(transaction, {
          action: CONTENT_AUDIT_ACTIONS.relationshipCreated,
          targetType: ENTITY_RELATIONSHIP_CLASS,
          after: relationshipAuditValue(created.record),
          targetVisibility: { visibility: created.record.visibility },
        });
        return ok(created.record);
      },
    );
  }

  /** Removes the link only; both endpoints are untouched. */
  async tombstone(
    actor: ActorRef,
    input: TombstoneInput,
    options: Pick<WriteOptions, 'audit'> = {},
  ): Promise<ContentWriteResult<RelationshipRecord>> {
    if (!validIds(input.campaignId, input.id)) return invalid('invalid_identifier');
    if (!check(Version, input.expectedVersion)) return invalid('invalid_version');
    const current = await this.#relationships.get(input.campaignId, input.id, {
      includeDeleted: true,
    });
    if (current === undefined) return HIDDEN;
    if (!this.#decider.decide(actor, 'delete', relationshipFacts(current)).allowed) return HIDDEN;
    if (current.deletedAt !== undefined) return DELETED;
    if (current.version !== input.expectedVersion) {
      return { ok: false, error: { code: 'version_conflict', current } };
    }
    return this.#relationships.transaction(
      async (transaction): Promise<ContentWriteResult<RelationshipRecord>> => {
        const deleted = await this.#relationships.tombstone(transaction, {
          campaignId: input.campaignId,
          id: input.id,
          expectedVersion: input.expectedVersion,
          actorUserId: actor.userId,
        });
        if (!deleted.ok) return casFailure(deleted);
        await options.audit?.(transaction, {
          action: CONTENT_AUDIT_ACTIONS.relationshipDeleted,
          targetType: ENTITY_RELATIONSHIP_CLASS,
          before: relationshipAuditValue(current),
          targetVisibility: { visibility: current.visibility },
        });
        return ok(deleted.record);
      },
    );
  }
}
