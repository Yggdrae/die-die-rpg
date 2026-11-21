import { type ActorRef, check, GM_ROLES, type Role, Visibility } from '@rpg/contracts';
import type { SyncPredicateDeclaration } from './authorization.ts';
import type { Capability, OwnershipField, ReplicatedSync, ResourceFacts } from './registry.ts';

/**
 * Provider-neutral sync predicate AST (`_techspec.md`, SyncPredicateCompiler). Compiled from the
 * same Resource Policy declaration as `AuthorizationService.decide`; feature 03 adapters translate
 * it to provider rules, and the equivalence suite evaluates it in-process and as SQL.
 *
 * Every node is evaluated for one requesting user against one row:
 *
 * - `member_role_in`: the requester holds a current (not removed) membership in the row's
 *   campaign with one of `roles`. It is the campaign scope: a non-member, a removed member, or a
 *   member of another campaign never matches.
 * - `visibility_mode_in`: the row's Visibility mode is one of `modes`.
 * - `targets_include_requester`: the row's Visibility targets contain the requester's user ID.
 * - `party_includes_requester`: a `party` row names a party of the requester. Only emitted while
 *   party targeting is active; no provider adapter can translate it until a party resolver ships.
 * - `owner_is_requester`: the row's ownership field equals the requester's user ID.
 * - `always` / `never`: constants (`never` is a `server_only` class or one no role may read).
 */
export type VisibilityMode = Visibility['mode'];

export type SyncPredicate =
  | { readonly kind: 'always' }
  | { readonly kind: 'never' }
  | { readonly kind: 'and'; readonly of: readonly SyncPredicate[] }
  | { readonly kind: 'or'; readonly of: readonly SyncPredicate[] }
  | { readonly kind: 'member_role_in'; readonly roles: readonly Role[] }
  | { readonly kind: 'visibility_mode_in'; readonly modes: readonly VisibilityMode[] }
  | { readonly kind: 'targets_include_requester' }
  | { readonly kind: 'party_includes_requester' }
  | { readonly kind: 'owner_is_requester'; readonly field: OwnershipField };

export interface SyncRule {
  readonly resourceClass: string;
  readonly capability: Capability;
  /** Row source; absent for a `server_only` class, whose predicate is `never`. */
  readonly source?: ReplicatedSync;
  /**
   * Tombstones replicate under the same predicate as live rows, evaluated on the tombstone's
   * current Visibility: a replica that may not read the row never receives its tombstone.
   */
  readonly tombstones: 'same_predicate';
  readonly predicate: SyncPredicate;
}

/** The requesting user and their current memberships, as the provider sees them. */
export interface SyncRequester {
  readonly userId: string;
  /** Current role in `campaignId`, or `undefined` for no current membership. */
  roleIn(campaignId: string): Role | undefined;
}

const ALWAYS: SyncPredicate = { kind: 'always' };
const NEVER: SyncPredicate = { kind: 'never' };

/** Compiles one declaration (see `SyncPredicateCompiler`) into the provider-neutral rule. */
export function compileSyncRule(declaration: SyncPredicateDeclaration): SyncRule {
  const base = {
    resourceClass: declaration.resourceClass,
    capability: declaration.capability,
    tombstones: 'same_predicate' as const,
    ...(declaration.source === undefined ? {} : { source: declaration.source }),
  };
  const roles: readonly Role[] = declaration.allowedRoles.filter((role) => role !== 'observer');
  if (declaration.source === undefined || roles.length === 0) return { ...base, predicate: NEVER };

  const clauses: SyncPredicate[] = [{ kind: 'member_role_in', roles }];
  const rule = declaration.ownership;
  if (rule !== undefined) {
    const exempt = rule.exemptRoles.filter((role) => roles.includes(role));
    const owner: SyncPredicate = { kind: 'owner_is_requester', field: rule.field };
    clauses.push(
      exempt.length === 0
        ? owner
        : { kind: 'or', of: [{ kind: 'member_role_in', roles: exempt }, owner] },
    );
  }
  // Campaign-wide classes keep the Visibility clause too: their rows are `everyone` by
  // declaration, which `rowPredicate` folds away for providers.
  clauses.push(visibilityPredicate(roles, declaration.partyTargetingActive));
  return { ...base, predicate: and(clauses) };
}

/**
 * Same semantics as the decision's Visibility step: `everyone` admits all, a targeted `players`
 * row admits its targets, GM roles see every other mode. `party` matches nobody, GM roles
 * included, until party targeting is active.
 */
function visibilityPredicate(roles: readonly Role[], partyTargetingActive: boolean): SyncPredicate {
  const gmRoles = GM_ROLES.filter((role) => roles.includes(role));
  const branches: SyncPredicate[] = [
    { kind: 'visibility_mode_in', modes: ['everyone'] },
    and([
      { kind: 'visibility_mode_in', modes: ['players'] },
      { kind: 'targets_include_requester' },
    ]),
  ];
  if (gmRoles.length > 0) {
    branches.push(
      and([
        { kind: 'member_role_in', roles: gmRoles },
        {
          kind: 'visibility_mode_in',
          modes: partyTargetingActive ? ['gm_only', 'players', 'party'] : ['gm_only', 'players'],
        },
      ]),
    );
  }
  if (partyTargetingActive) {
    branches.push(
      and([{ kind: 'visibility_mode_in', modes: ['party'] }, { kind: 'party_includes_requester' }]),
    );
  }
  return { kind: 'or', of: branches };
}

function and(of: readonly SyncPredicate[]): SyncPredicate {
  return { kind: 'and', of };
}

/**
 * The predicate a provider applies to stored rows, simplified. For a `campaign_wide` source the
 * rows have no Visibility columns and are `everyone` by declaration, so every Visibility node is
 * folded to a constant. Equivalent to `rule.predicate` on every row the source can hold.
 */
export function rowPredicate(rule: SyncRule): SyncPredicate {
  if (rule.source === undefined) return NEVER;
  if (rule.source.visibility !== 'campaign_wide') return simplify(rule.predicate);
  return simplify(foldVisibility(rule.predicate, { mode: 'everyone' }));
}

function foldVisibility(predicate: SyncPredicate, visibility: Visibility): SyncPredicate {
  switch (predicate.kind) {
    case 'and':
    case 'or':
      return {
        kind: predicate.kind,
        of: predicate.of.map((item) => foldVisibility(item, visibility)),
      };
    case 'visibility_mode_in':
      return predicate.modes.includes(visibility.mode) ? ALWAYS : NEVER;
    case 'targets_include_requester':
    case 'party_includes_requester':
      return visibility.mode === 'everyone' || visibility.mode === 'gm_only' ? NEVER : predicate;
    default:
      return predicate;
  }
}

/** Constant propagation and single-child flattening; never changes the truth value. */
export function simplify(predicate: SyncPredicate): SyncPredicate {
  if (predicate.kind !== 'and' && predicate.kind !== 'or') return predicate;
  const identity = predicate.kind === 'and' ? 'always' : 'never';
  const absorbing = predicate.kind === 'and' ? 'never' : 'always';
  const items: SyncPredicate[] = [];
  for (const item of predicate.of.map(simplify)) {
    if (item.kind === absorbing) return item;
    if (item.kind === identity) continue;
    if (item.kind === predicate.kind) items.push(...item.of);
    else items.push(item);
  }
  if (items.length === 0) return predicate.kind === 'and' ? ALWAYS : NEVER;
  if (items.length === 1) return items[0] as SyncPredicate;
  return { kind: predicate.kind, of: items };
}

/** In-process evaluation of a compiled rule for one requester and one row. */
export function evaluateSyncRule(
  rule: SyncRule,
  requester: SyncRequester,
  facts: ResourceFacts,
): boolean {
  if (rule.source === undefined || facts.resourceClass !== rule.resourceClass) return false;
  if (!wellFormedFacts(facts)) return false;
  return evaluatePredicate(rule.predicate, requester, facts);
}

/** Malformed owner-loaded facts match nothing, here and in `decide` (no exception, no grant). */
export function wellFormedFacts(facts: ResourceFacts): boolean {
  if (!check(Visibility, facts.visibility)) return false;
  return (
    facts.partyIds === undefined ||
    (Array.isArray(facts.partyIds) && facts.partyIds.every((id) => typeof id === 'string'))
  );
}

export function evaluatePredicate(
  predicate: SyncPredicate,
  requester: SyncRequester,
  facts: ResourceFacts,
): boolean {
  switch (predicate.kind) {
    case 'always':
      return true;
    case 'never':
      return false;
    case 'and':
      return predicate.of.every((item) => evaluatePredicate(item, requester, facts));
    case 'or':
      return predicate.of.some((item) => evaluatePredicate(item, requester, facts));
    case 'member_role_in': {
      const role = requester.roleIn(facts.campaignId);
      return role !== undefined && predicate.roles.includes(role);
    }
    case 'visibility_mode_in':
      return predicate.modes.includes(facts.visibility.mode);
    case 'targets_include_requester':
      return targetsOf(facts.visibility).includes(requester.userId);
    case 'party_includes_requester':
      return (
        facts.visibility.mode === 'party' &&
        facts.visibility.partyIds.some((partyId) => facts.partyIds?.includes(partyId) === true)
      );
    case 'owner_is_requester': {
      const owner = facts[predicate.field];
      return owner !== undefined && owner === requester.userId;
    }
  }
}

/** The stored targets column: user IDs for `players`, party IDs for `party`, else empty. */
function targetsOf(visibility: Visibility): readonly string[] {
  if (visibility.mode === 'players') return visibility.playerIds;
  if (visibility.mode === 'party') return visibility.partyIds;
  return [];
}

/** A resolved Actor seen as a requester: a current member of exactly its own campaign. */
export function requesterFromActor(actor: ActorRef): SyncRequester {
  return {
    userId: actor.userId,
    roleIn: (campaignId) => (campaignId === actor.campaignId ? actor.role : undefined),
  };
}
