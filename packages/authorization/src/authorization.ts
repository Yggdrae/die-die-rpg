import { type ActorRef, GM_ROLES, type Role, type Visibility } from '@rpg/contracts';
import {
  type Capability,
  KNOWN_ROLES,
  type OwnershipRule,
  type ReplicatedSync,
  type ResourceFacts,
  type ResourcePolicy,
  type ResourcePolicyRegistry,
} from './registry.ts';
import {
  compileSyncRule,
  evaluateSyncRule,
  requesterFromActor,
  type SyncRule,
  wellFormedFacts,
} from './sync-predicate.ts';

export type DecisionReason =
  | 'allowed_by_policy'
  | 'unknown_resource_class'
  | 'unknown_capability'
  | 'unknown_role'
  | 'observer_denied'
  | 'cross_campaign'
  | 'invalid_facts'
  | 'ownership_denied'
  | 'visibility_denied'
  | 'party_unresolved'
  | 'role_denied';

export type Decision =
  | { readonly allowed: true; readonly reason: 'allowed_by_policy' }
  | { readonly allowed: false; readonly reason: Exclude<DecisionReason, 'allowed_by_policy'> };

export interface SyncPredicateDeclaration {
  readonly resourceClass: string;
  readonly capability: Capability;
  readonly allowedRoles: readonly Role[];
  /** Ownership Rule restricting this capability, if any. */
  readonly ownership?: Pick<OwnershipRule, 'field' | 'exemptRoles'>;
  /** `party` Visibility matches only when a party resolver is active. */
  readonly partyTargetingActive: boolean;
  /** Row source; `undefined` for a `server_only` class, whose predicate matches nothing. */
  readonly source?: ReplicatedSync;
}

export interface CompiledSyncPredicate {
  readonly declaration: SyncPredicateDeclaration;
  /** Provider-neutral AST that feature 03 adapters translate (`sync-predicate.ts`). */
  readonly rule: SyncRule;
  /** Evaluates `rule` for a resolved Actor (a current member of `actor.campaignId`). */
  matches(actor: ActorRef, facts: ResourceFacts): boolean;
}

export class AuthorizationService {
  constructor(private readonly registry: ResourcePolicyRegistry) {}

  decide(actor: ActorRef, capability: Capability, facts: ResourceFacts): Decision {
    const policy = this.registry.get(facts.resourceClass);
    if (policy === undefined) return deny('unknown_resource_class');
    if (!policy.capabilities.includes(capability)) return deny('unknown_capability');
    if (!KNOWN_ROLES.includes(actor.role)) return deny('unknown_role');
    if (actor.role === 'observer') return deny('observer_denied');
    if (actor.campaignId !== facts.campaignId) return deny('cross_campaign');
    // Owner-loaded facts are data: a malformed Visibility denies instead of throwing.
    if (!wellFormedFacts(facts)) return deny('invalid_facts');
    if (!ownershipSatisfied(policy.ownership, capability, actor, facts)) {
      return deny('ownership_denied');
    }
    if (facts.visibility.mode === 'party' && !this.registry.partyTargetingActive) {
      return deny('party_unresolved');
    }
    if (!visibilityAdmits(actor, facts.visibility, facts.partyIds))
      return deny('visibility_denied');
    if (!policy.roleCapabilities[actor.role].includes(capability)) return deny('role_denied');
    return { allowed: true, reason: 'allowed_by_policy' };
  }
}

export class SyncPredicateCompiler {
  constructor(private readonly registry: ResourcePolicyRegistry) {}

  compile(resourceClass: string, capability: Capability = 'read'): CompiledSyncPredicate {
    const policy = this.registry.get(resourceClass);
    if (policy === undefined || !policy.capabilities.includes(capability)) {
      throw new Error('unknown_sync_policy');
    }
    const declaration = declarationFor(policy, capability, this.registry.partyTargetingActive);
    const rule = compileSyncRule(declaration);
    return {
      declaration,
      rule,
      matches: (actor, facts) => evaluateSyncRule(rule, requesterFromActor(actor), facts),
    };
  }

  /** Compiled rules for every registered class declaring `capability`, in registration order. */
  rules(capability: Capability = 'read'): SyncRule[] {
    return this.registry
      .policies()
      .filter((policy) => policy.capabilities.includes(capability))
      .map((policy) => this.compile(policy.resourceClass, capability).rule);
  }
}

function declarationFor(
  policy: ResourcePolicy,
  capability: Capability,
  partyTargetingActive: boolean,
): SyncPredicateDeclaration {
  const rule = policy.ownership;
  return {
    resourceClass: policy.resourceClass,
    capability,
    allowedRoles: KNOWN_ROLES.filter((role) => policy.roleCapabilities[role].includes(capability)),
    ...(rule?.capabilities.includes(capability)
      ? { ownership: { field: rule.field, exemptRoles: rule.exemptRoles } }
      : {}),
    partyTargetingActive,
    ...(policy.sync.kind === 'replicated' ? { source: policy.sync } : {}),
  };
}

/** Evaluates the compiled AST of `declaration` for a resolved Actor. */
export function evaluateSyncPredicate(
  declaration: SyncPredicateDeclaration,
  actor: ActorRef,
  facts: ResourceFacts,
): boolean {
  return evaluateSyncRule(compileSyncRule(declaration), requesterFromActor(actor), facts);
}

export function toPublicAuthorizationError(_decision: Decision): 'not_found_or_forbidden' {
  return 'not_found_or_forbidden';
}

function deny(reason: Exclude<DecisionReason, 'allowed_by_policy'>): Decision {
  return { allowed: false, reason };
}

function ownershipSatisfied(
  rule: OwnershipRule | undefined,
  capability: Capability,
  actor: ActorRef,
  facts: ResourceFacts,
): boolean {
  if (rule === undefined || !rule.capabilities.includes(capability)) return true;
  if (rule.exemptRoles.includes(actor.role)) return true;
  const owner = facts[rule.field];
  return owner !== undefined && owner === actor.userId;
}

/**
 * The Visibility part of `decide`, pure: whether `actor` may see a record stored with `visibility`. Feature 20
 * filters search results with it at query time (its D-05). `partyIds` come only from a registered party resolver.
 */
export function visibilityAdmits(
  actor: Pick<ActorRef, 'userId' | 'role'>,
  visibility: Visibility,
  partyIds?: readonly string[],
): boolean {
  if (visibility.mode === 'everyone') return true;
  // GM roles see every mode (`_bdd.md`, Each visibility mode decides one way).
  if (GM_ROLES.includes(actor.role)) return true;
  if (visibility.mode === 'gm_only') return false;
  if (visibility.mode === 'players') return visibility.playerIds.includes(actor.userId);
  if (partyIds === undefined) return false;
  return visibility.partyIds.some((partyId) => partyIds.includes(partyId));
}
