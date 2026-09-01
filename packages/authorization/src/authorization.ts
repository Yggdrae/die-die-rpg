import type { ActorRef, Role, Visibility } from '@rpg/contracts';

export type Capability =
  | 'read'
  | 'create'
  | 'update'
  | 'delete'
  | 'reveal'
  | 'manage_members'
  | 'export'
  | (string & {});

export type DecisionReason =
  | 'allowed_by_policy'
  | 'unknown_resource_class'
  | 'unknown_capability'
  | 'unknown_role'
  | 'observer_denied'
  | 'cross_campaign'
  | 'visibility_denied'
  | 'party_unresolved'
  | 'role_denied';

export type Decision =
  | { readonly allowed: true; readonly reason: 'allowed_by_policy' }
  | { readonly allowed: false; readonly reason: Exclude<DecisionReason, 'allowed_by_policy'> };

export interface ResourceFacts {
  readonly campaignId: string;
  readonly resourceClass: string;
  readonly resourceId: string;
  readonly visibility: Visibility;
  readonly version: number;
  readonly authorUserId?: string;
  readonly partyIds?: readonly string[];
}

export interface ResourcePolicy {
  readonly resourceClass: string;
  readonly capabilities: readonly Capability[];
  readonly roleCapabilities: Readonly<Record<Role, readonly Capability[]>>;
  readonly authorPrivate?: boolean;
}

export interface SyncPredicateDeclaration {
  readonly resourceClass: string;
  readonly capability: Capability;
  readonly allowedRoles: readonly Role[];
  readonly authorPrivate: boolean;
}

export interface CompiledSyncPredicate {
  readonly declaration: SyncPredicateDeclaration;
  matches(actor: ActorRef, facts: ResourceFacts): boolean;
}

const KNOWN_ROLES: readonly Role[] = ['owner', 'gm', 'assistant_gm', 'player', 'observer'];

export class ResourcePolicyRegistry {
  private readonly policies = new Map<string, ResourcePolicy>();

  register(policy: ResourcePolicy): void {
    if (policy.resourceClass.trim() === '' || this.policies.has(policy.resourceClass)) {
      throw new Error('invalid_resource_policy');
    }
    const declared = new Set(policy.capabilities);
    if (declared.size !== policy.capabilities.length || declared.size === 0) {
      throw new Error('invalid_resource_policy');
    }
    for (const role of KNOWN_ROLES) {
      const capabilities = policy.roleCapabilities[role];
      if (
        capabilities === undefined ||
        capabilities.some((capability) => !declared.has(capability))
      ) {
        throw new Error('invalid_resource_policy');
      }
    }
    if (policy.roleCapabilities.observer.length !== 0) {
      throw new Error('invalid_resource_policy');
    }
    this.policies.set(policy.resourceClass, policy);
  }

  get(resourceClass: string): ResourcePolicy | undefined {
    return this.policies.get(resourceClass);
  }
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
    if (!isVisible(actor, facts, policy)) return deny('visibility_denied');
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
    const declaration: SyncPredicateDeclaration = {
      resourceClass,
      capability,
      allowedRoles: KNOWN_ROLES.filter((role) =>
        policy.roleCapabilities[role].includes(capability),
      ),
      authorPrivate: policy.authorPrivate ?? false,
    };
    return {
      declaration,
      matches: (actor, facts) => evaluateSyncPredicate(declaration, actor, facts),
    };
  }
}

export function evaluateSyncPredicate(
  declaration: SyncPredicateDeclaration,
  actor: ActorRef,
  facts: ResourceFacts,
): boolean {
  if (actor.role === 'observer') return false;
  if (actor.campaignId !== facts.campaignId) return false;
  if (facts.resourceClass !== declaration.resourceClass) return false;
  if (!declaration.allowedRoles.includes(actor.role)) return false;
  if (declaration.authorPrivate && facts.authorUserId !== actor.userId) return false;
  if (facts.visibility.mode === 'everyone') return true;
  if (facts.visibility.mode === 'gm_only') {
    return actor.role === 'owner' || actor.role === 'gm' || actor.role === 'assistant_gm';
  }
  if (facts.visibility.mode === 'players') return facts.visibility.playerIds.includes(actor.userId);
  if (facts.partyIds === undefined) return false;
  return facts.visibility.partyIds.some((partyId) => facts.partyIds?.includes(partyId));
}

export function toPublicAuthorizationError(_decision: Decision): 'not_found_or_forbidden' {
  return 'not_found_or_forbidden';
}

function deny(reason: Exclude<DecisionReason, 'allowed_by_policy'>): Decision {
  return { allowed: false, reason };
}

function isVisible(actor: ActorRef, facts: ResourceFacts, policy: ResourcePolicy): boolean {
  if (policy.authorPrivate && facts.authorUserId !== actor.userId) return false;
  if (facts.visibility.mode === 'everyone') return true;
  if (facts.visibility.mode === 'gm_only') {
    return actor.role === 'owner' || actor.role === 'gm' || actor.role === 'assistant_gm';
  }
  if (facts.visibility.mode === 'players') return facts.visibility.playerIds.includes(actor.userId);
  if (facts.partyIds === undefined) return false;
  return facts.visibility.partyIds.some((partyId) => facts.partyIds?.includes(partyId));
}
