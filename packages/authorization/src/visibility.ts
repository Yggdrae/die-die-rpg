import type {
  AuditSqlExecutor,
  CampaignAuditSubmission,
  DurableAuditRecorder,
  TargetVisibilitySnapshot,
} from '@rpg/audit';
import {
  type ActorRef,
  check,
  GM_ONLY,
  Id,
  type Result,
  Version,
  type Visibility,
} from '@rpg/contracts';
import { AuthorizationService, type Decision } from './authorization.ts';
import type {
  ResourceFacts,
  ResourcePolicy,
  ResourcePolicyRegistry,
  TargetMode,
} from './registry.ts';

/** `_db.md`, Visibility Mutation Transaction. Un-reveal uses the same `reveal` capability. */
export type VisibilityOperation = 'reveal' | 'unreveal';

/**
 * What a change names. `everyone` reveals to the whole campaign, or (un-reveal) removes every
 * audience and stores `gm_only`. Targeted IDs are set-unioned (reveal) or subtracted (un-reveal).
 */
export type VisibilityTarget =
  | { readonly mode: 'everyone' }
  | { readonly mode: 'players'; readonly playerIds: readonly string[] }
  | { readonly mode: 'party'; readonly partyIds: readonly string[] };

export interface VisibilityChange {
  readonly campaignId: string;
  readonly resourceClass: string;
  readonly resourceId: string;
  readonly operation: VisibilityOperation;
  readonly target: VisibilityTarget;
  /** Version the actor last saw. A mismatch is an explicit conflict, never a merge. */
  readonly expectedVersion: number;
  /** Feature 03 mutation ID or request idempotency key; becomes the audit origin ID. */
  readonly mutationId?: string;
}

export type VisibilityChangeRejection =
  | 'invalid_change'
  | 'actor_not_member'
  | 'unknown_resource_class'
  | 'not_found'
  | 'denied'
  | 'target_mode_not_allowed'
  | 'party_unresolved'
  | 'target_not_member'
  | 'incompatible_visibility';

/**
 * `rejected` reasons up to and including `denied` must reach the public boundary as the same
 * `not_found_or_forbidden` (task 04). Later reasons are only reachable by an authorized actor.
 */
export type VisibilityChangeResult =
  | {
      readonly status: 'changed';
      readonly before: Visibility;
      readonly facts: ResourceFacts;
      /** `after_commit` means the owner adapter did not call `recordAudit` (a contract defect). */
      readonly audit: 'within_transaction' | 'after_commit';
    }
  | { readonly status: 'unchanged'; readonly facts: ResourceFacts }
  | { readonly status: 'conflict' }
  | {
      readonly status: 'rejected';
      readonly reason: VisibilityChangeRejection;
      readonly decision?: Decision;
    };

/** Same shape as `@rpg/identity` `ActorResolver`, the only sanctioned membership read. */
export interface VisibilityActorResolver {
  resolve(userId: string, campaignId: string): Promise<Result<ActorRef, 'membership_not_found'>>;
}

export type VisibilityAuditRecorder = Pick<DurableAuditRecorder, 'recordWithin' | 'recordCampaign'>;

export interface VisibilityServiceLog {
  /** Owner adapter committed without calling `recordAudit`; audit fell back to post-commit. */
  auditOutsideTransaction(resourceClass: string): void;
}

export interface VisibilityServiceDependencies {
  readonly registry: ResourcePolicyRegistry;
  readonly actors: VisibilityActorResolver;
  readonly audit: VisibilityAuditRecorder;
  readonly log?: VisibilityServiceLog;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

export const VISIBILITY_AUDIT_ACTIONS = {
  reveal: 'visibility.revealed',
  unreveal: 'visibility.unrevealed',
} as const satisfies Record<VisibilityOperation, string>;

/** `ResourcePolicy.revealTargets` default. */
export const DEFAULT_REVEAL_TARGETS: readonly TargetMode[] = ['players'];

/** Bound on IDs named by one change (each reveal target costs one membership lookup). */
export const MAX_VISIBILITY_TARGETS = 100;

/**
 * Versioned reveal/un-reveal (`_db.md`, Visibility Mutation Transaction). The owner adapter locks
 * and compares the version; the audit event is enqueued in the adapter's transaction. A conflict
 * is returned, never retried: a retry could combine a decision made against older memberships.
 */
export class VisibilityService {
  readonly #deps: VisibilityServiceDependencies;
  readonly #authorization: AuthorizationService;
  readonly #now: () => Date;
  readonly #newId: () => string;

  constructor(deps: VisibilityServiceDependencies) {
    this.#deps = deps;
    this.#authorization = new AuthorizationService(deps.registry);
    this.#now = deps.now ?? (() => new Date());
    this.#newId = deps.newId ?? (() => crypto.randomUUID());
  }

  /** `actorUserId` is the authenticated user; the role is always resolved here, never supplied. */
  async change(actorUserId: string, change: VisibilityChange): Promise<VisibilityChangeResult> {
    if (!check(Id, actorUserId) || !isValidVisibilityChange(change)) {
      return rejected('invalid_change');
    }
    const resolved = await this.#deps.actors.resolve(actorUserId, change.campaignId);
    if (!resolved.ok) return rejected('actor_not_member');
    const actor = resolved.value;

    const policy = this.#deps.registry.get(change.resourceClass);
    const adapter = this.#deps.registry.adapterFor(change.resourceClass);
    if (policy === undefined || adapter === undefined) return rejected('unknown_resource_class');
    const facts = await adapter.loadFacts(change.campaignId, change.resourceId);
    if (
      facts === undefined ||
      facts.campaignId !== change.campaignId ||
      facts.resourceId !== change.resourceId ||
      facts.resourceClass !== change.resourceClass
    ) {
      return rejected('not_found');
    }

    const decision = this.#authorization.decide(actor, 'reveal', facts);
    if (!decision.allowed) return { status: 'rejected', reason: 'denied', decision };
    // Early compare; the adapter repeats it under the row lock.
    if (facts.version !== change.expectedVersion) return { status: 'conflict' };

    // Targets are checked after the decision so an unauthorized actor learns nothing about
    // membership.
    const targetProblem = await this.#checkTarget(policy, change);
    if (targetProblem !== undefined) return rejected(targetProblem);

    const before = normalizeVisibility(facts.visibility);
    const transition = applyVisibilityChange(before, change.operation, change.target);
    if (!transition.ok) return rejected(transition.reason);
    const after = transition.visibility;
    if (sameVisibility(before, after)) return { status: 'unchanged', facts };

    const submission = this.#auditSubmission(actor, change, facts, before, after);
    let audited = false;
    const written = await adapter.writeVisibility({
      campaignId: change.campaignId,
      resourceId: change.resourceId,
      expectedVersion: facts.version,
      visibility: after,
      actor,
      recordAudit: async (executor: AuditSqlExecutor) => {
        if (audited) return;
        audited = true;
        await this.#deps.audit.recordWithin(executor, submission);
      },
    });
    if (!written.ok) {
      if (written.reason === 'version_conflict') return { status: 'conflict' };
      // B-1: the owner's invariant refused the value; nothing changed and nothing is audited.
      if (written.reason === 'invariant_violation') return rejected('incompatible_visibility');
      return rejected('not_found');
    }
    if (!audited) {
      // Same origin ID, so a store that already holds the event resolves it as a duplicate.
      this.#deps.log?.auditOutsideTransaction(change.resourceClass);
      await this.#deps.audit.recordCampaign(submission);
    }
    return {
      status: 'changed',
      before,
      facts: written.facts,
      audit: audited ? 'within_transaction' : 'after_commit',
    };
  }

  async #checkTarget(
    policy: ResourcePolicy,
    change: VisibilityChange,
  ): Promise<VisibilityChangeRejection | undefined> {
    const target = change.target;
    if (target.mode === 'everyone') return undefined;
    if (!(policy.revealTargets ?? DEFAULT_REVEAL_TARGETS).includes(target.mode)) {
      return 'target_mode_not_allowed';
    }
    // No party resolver exists in P0, so party IDs cannot be validated: fail closed.
    if (target.mode === 'party') return 'party_unresolved';
    // Subtraction only narrows, so un-reveal may remove a stale (removed-member) ID.
    if (change.operation === 'unreveal') return undefined;
    const resolved = await Promise.all(
      normalizeTargetIds(target.playerIds).map((userId) =>
        this.#deps.actors.resolve(userId, change.campaignId),
      ),
    );
    return resolved.every((result) => result.ok) ? undefined : 'target_not_member';
  }

  #auditSubmission(
    actor: ActorRef,
    change: VisibilityChange,
    facts: ResourceFacts,
    before: Visibility,
    after: Visibility,
  ): CampaignAuditSubmission {
    // History of a Visibility change names its recipients, so it is GM-only (and follows the
    // record's author for an Ownership Rule) until feature 06 task 03 defines a narrower rule.
    const targetVisibility: TargetVisibilitySnapshot =
      facts.authorUserId === undefined
        ? { visibility: GM_ONLY }
        : { visibility: GM_ONLY, authorUserId: facts.authorUserId };
    return {
      event: {
        campaignId: change.campaignId,
        actor,
        action: VISIBILITY_AUDIT_ACTIONS[change.operation],
        targetType: change.resourceClass,
        targetId: change.resourceId,
        before: { visibility: before, version: facts.version },
        after: { visibility: after, version: facts.version + 1 },
        at: this.#now().toISOString(),
        private: false,
      },
      originMutationId: change.mutationId ?? this.#newId(),
      targetVisibility,
    };
  }
}

function rejected(reason: VisibilityChangeRejection): VisibilityChangeResult {
  return { status: 'rejected', reason };
}

export function isValidVisibilityChange(change: VisibilityChange): boolean {
  return (
    typeof change === 'object' &&
    change !== null &&
    check(Id, change.campaignId) &&
    check(Id, change.resourceId) &&
    typeof change.resourceClass === 'string' &&
    change.resourceClass.trim() !== '' &&
    (change.operation === 'reveal' || change.operation === 'unreveal') &&
    check(Version, change.expectedVersion) &&
    (change.mutationId === undefined || check(Id, change.mutationId)) &&
    isValidTarget(change.target)
  );
}

function isValidTarget(target: VisibilityTarget): boolean {
  if (typeof target !== 'object' || target === null) return false;
  if (target.mode === 'everyone') return true;
  const ids =
    target.mode === 'players' ? target.playerIds : target.mode === 'party' ? target.partyIds : [];
  return (
    Array.isArray(ids) &&
    ids.length >= 1 &&
    ids.length <= MAX_VISIBILITY_TARGETS &&
    ids.every((id) => check(Id, id))
  );
}

/** Sorted (code-unit order, equal to SQL `COLLATE "C"`), unique target IDs. */
export function normalizeTargetIds(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort();
}

/** Canonical Visibility: sorted unique targets; an empty targeted set becomes `gm_only`. */
export function normalizeVisibility(visibility: Visibility): Visibility {
  if (visibility.mode === 'players') {
    const playerIds = normalizeTargetIds(visibility.playerIds);
    return playerIds.length === 0 ? { mode: 'gm_only' } : { mode: 'players', playerIds };
  }
  if (visibility.mode === 'party') {
    const partyIds = normalizeTargetIds(visibility.partyIds);
    return partyIds.length === 0 ? { mode: 'gm_only' } : { mode: 'party', partyIds };
  }
  return { mode: visibility.mode };
}

export type VisibilityTransition =
  | { readonly ok: true; readonly visibility: Visibility }
  | { readonly ok: false; readonly reason: 'incompatible_visibility' };

/**
 * Pure set arithmetic. Reveal unions recipients (and is idempotent); un-reveal subtracts them.
 * Mixing targeted modes, or subtracting named recipients from `everyone`, is not representable
 * and is rejected rather than widened or guessed.
 */
export function applyVisibilityChange(
  current: Visibility,
  operation: VisibilityOperation,
  target: VisibilityTarget,
): VisibilityTransition {
  const base = normalizeVisibility(current);
  if (target.mode === 'everyone') {
    return { ok: true, visibility: operation === 'reveal' ? { mode: 'everyone' } : GM_ONLY };
  }
  const named = target.mode === 'players' ? target.playerIds : target.partyIds;
  if (operation === 'reveal') {
    if (base.mode === 'everyone') return { ok: true, visibility: base };
    if (base.mode === 'gm_only') return { ok: true, visibility: targeted(target.mode, named) };
    if (base.mode !== target.mode) return { ok: false, reason: 'incompatible_visibility' };
    return { ok: true, visibility: targeted(target.mode, [...targetIds(base), ...named]) };
  }
  if (base.mode === 'gm_only') return { ok: true, visibility: base };
  if (base.mode !== target.mode) return { ok: false, reason: 'incompatible_visibility' };
  const removed = new Set(named);
  return {
    ok: true,
    visibility: targeted(
      target.mode,
      targetIds(base).filter((id) => !removed.has(id)),
    ),
  };
}

function targeted(mode: 'players' | 'party', ids: readonly string[]): Visibility {
  return normalizeVisibility(
    mode === 'players' ? { mode, playerIds: [...ids] } : { mode, partyIds: [...ids] },
  );
}

function targetIds(visibility: Visibility): readonly string[] {
  if (visibility.mode === 'players') return visibility.playerIds;
  if (visibility.mode === 'party') return visibility.partyIds;
  return [];
}

export function sameVisibility(left: Visibility, right: Visibility): boolean {
  const a = visibilityToColumns(left);
  const b = visibilityToColumns(right);
  return a.mode === b.mode && a.targets.join(',') === b.targets.join(',');
}

/** `_db.md` standard columns: `visibility_mode text`, `visibility_targets jsonb`. */
export interface VisibilityColumns {
  readonly mode: Visibility['mode'];
  readonly targets: readonly string[];
}

export function visibilityToColumns(visibility: Visibility): VisibilityColumns {
  const normalized = normalizeVisibility(visibility);
  return { mode: normalized.mode, targets: targetIds(normalized) };
}

/**
 * Strict reverse mapping. Anything but the canonical representation (unknown mode, targets on an
 * audience-wide mode, empty/unsorted/duplicate/non-UUID targets) returns `undefined`; an adapter
 * must then treat the record as unreadable rather than guess an audience.
 */
export function visibilityFromColumns(mode: unknown, targets: unknown): Visibility | undefined {
  if (!Array.isArray(targets) || !targets.every((id) => check(Id, id))) return undefined;
  const ids = targets as string[];
  if (mode === 'gm_only' || mode === 'everyone') return ids.length === 0 ? { mode } : undefined;
  if (mode !== 'players' && mode !== 'party') return undefined;
  const canonical = normalizeTargetIds(ids);
  if (ids.length === 0 || canonical.join(',') !== ids.join(',')) return undefined;
  return mode === 'players' ? { mode, playerIds: canonical } : { mode, partyIds: canonical };
}
