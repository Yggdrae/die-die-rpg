import type { ActorRef, Role, Visibility } from '@rpg/contracts';
import { AuthorizationService, type Decision, SyncPredicateCompiler } from './authorization.ts';
import {
  type Capability,
  KNOWN_ROLES,
  type ResourceFacts,
  type ResourcePolicy,
  type ResourcePolicyRegistry,
} from './registry.ts';

/**
 * Shared conformance kit (`_bdd.md`, Every content-owning class runs the shared matrix; Both rules
 * come from one declaration). Pure: owners call it from their own tests and assert no findings.
 */

const CAMPAIGN = '00000000-0000-4000-8000-00000000c001';
const OTHER_CAMPAIGN = '00000000-0000-4000-8000-00000000c002';
const ACTOR_USER = '00000000-0000-4000-8000-00000000a001';
const OTHER_USER = '00000000-0000-4000-8000-00000000a002';
const ACTOR_PARTY = '00000000-0000-4000-8000-00000000b001';
const OTHER_PARTY = '00000000-0000-4000-8000-00000000b002';

export type AuthorFact = 'actor' | 'other' | 'none';

export interface ConformanceCase {
  readonly actor: ActorRef;
  readonly capability: Capability;
  readonly facts: ResourceFacts;
  readonly author: AuthorFact;
  readonly crossCampaign: boolean;
}

export type ConformanceProblem =
  | 'sync_divergence'
  | 'observer_allowed'
  | 'cross_campaign_allowed'
  | 'ownership_bypassed'
  | 'not_author_private';

export interface ConformanceFinding {
  readonly problem: ConformanceProblem;
  readonly case?: ConformanceCase;
  readonly decision?: Decision;
  readonly synced?: boolean;
}

export interface ConformanceReport {
  readonly resourceClass: string;
  readonly cases: number;
  readonly findings: readonly ConformanceFinding[];
}

const VISIBILITIES: readonly Visibility[] = [
  { mode: 'everyone' },
  { mode: 'gm_only' },
  { mode: 'players', playerIds: [ACTOR_USER] },
  { mode: 'players', playerIds: [OTHER_USER] },
  { mode: 'party', partyIds: [ACTOR_PARTY] },
  { mode: 'party', partyIds: [OTHER_PARTY] },
];

/** Every MVP role x declared capability x Visibility mode x campaign x author combination. */
export function conformanceCases(policy: ResourcePolicy): ConformanceCase[] {
  const cases: ConformanceCase[] = [];
  for (const role of KNOWN_ROLES) {
    for (const capability of policy.capabilities) {
      for (const visibility of VISIBILITIES) {
        for (const crossCampaign of [false, true]) {
          for (const author of ['actor', 'other', 'none'] as const) {
            cases.push(
              conformanceCase(policy.resourceClass, role, capability, visibility, {
                author,
                crossCampaign,
              }),
            );
          }
        }
      }
    }
  }
  return cases;
}

function conformanceCase(
  resourceClass: string,
  role: Role,
  capability: Capability,
  visibility: Visibility,
  options: { readonly author: AuthorFact; readonly crossCampaign: boolean },
): ConformanceCase {
  const authorUserId =
    options.author === 'actor' ? ACTOR_USER : options.author === 'other' ? OTHER_USER : undefined;
  return {
    actor: {
      userId: ACTOR_USER,
      campaignId: options.crossCampaign ? OTHER_CAMPAIGN : CAMPAIGN,
      role,
    },
    capability,
    facts: {
      campaignId: CAMPAIGN,
      resourceClass,
      resourceId: '00000000-0000-4000-8000-00000000d001',
      visibility,
      version: 1,
      ...(authorUserId === undefined ? {} : { authorUserId }),
      partyIds: [ACTOR_PARTY],
    },
    author: options.author,
    crossCampaign: options.crossCampaign,
  };
}

/**
 * Runs the shared matrix for one registered class: API and compiled sync predicate agree on every
 * read case, observer and cross-campaign actors are denied every capability, and no non-exempt
 * non-owner passes a capability covered by the Ownership Rule.
 */
export function runPolicyConformance(
  registry: ResourcePolicyRegistry,
  resourceClass: string,
): ConformanceReport {
  const policy = requirePolicy(registry, resourceClass);
  const authorization = new AuthorizationService(registry);
  const predicate = new SyncPredicateCompiler(registry).compile(resourceClass, 'read');
  const findings: ConformanceFinding[] = [];
  const cases = conformanceCases(policy);
  for (const item of cases) {
    const decision = authorization.decide(item.actor, item.capability, item.facts);
    if (item.capability === 'read' && policy.sync.kind === 'replicated') {
      const synced = predicate.matches(item.actor, item.facts);
      if (synced !== decision.allowed) {
        findings.push({ problem: 'sync_divergence', case: item, decision, synced });
      }
    }
    if (!decision.allowed) continue;
    if (item.actor.role === 'observer') findings.push({ problem: 'observer_allowed', case: item });
    if (item.crossCampaign) findings.push({ problem: 'cross_campaign_allowed', case: item });
    const rule = policy.ownership;
    if (
      rule?.capabilities.includes(item.capability) &&
      !rule.exemptRoles.includes(item.actor.role) &&
      item.author !== 'actor'
    ) {
      findings.push({ problem: 'ownership_bypassed', case: item, decision });
    }
  }
  return { resourceClass, cases: cases.length, findings };
}

/**
 * Author-private conformance (`_bdd.md`, A player-authored private note is not readable by a GM
 * role): every capability denies every non-author under every Visibility, GM roles included, and
 * the replica predicate never delivers the record to a non-author.
 */
export function checkAuthorPrivate(
  registry: ResourcePolicyRegistry,
  resourceClass: string,
): ConformanceReport {
  const policy = requirePolicy(registry, resourceClass);
  const rule = policy.ownership;
  const findings: ConformanceFinding[] = [];
  if (
    rule === undefined ||
    rule.exemptRoles.length !== 0 ||
    policy.capabilities.some((capability) => !rule.capabilities.includes(capability))
  ) {
    findings.push({ problem: 'not_author_private' });
  }
  const authorization = new AuthorizationService(registry);
  const predicate = new SyncPredicateCompiler(registry).compile(resourceClass, 'read');
  const cases = conformanceCases(policy).filter((item) => item.author !== 'actor');
  for (const item of cases) {
    const decision = authorization.decide(item.actor, item.capability, item.facts);
    if (decision.allowed) findings.push({ problem: 'ownership_bypassed', case: item, decision });
    if (item.capability === 'read' && predicate.matches(item.actor, item.facts)) {
      findings.push({ problem: 'ownership_bypassed', case: item, synced: true });
    }
  }
  return { resourceClass, cases: cases.length, findings };
}

function requirePolicy(registry: ResourcePolicyRegistry, resourceClass: string): ResourcePolicy {
  const policy = registry.get(resourceClass);
  if (policy === undefined) throw new Error(`unregistered_resource_class: ${resourceClass}`);
  return policy;
}

/**
 * Conformance fixture: a player-authored private note (`_domain.md`, Author-Private Content).
 * Not a product class; owners model their own note class on it and run `checkAuthorPrivate`.
 */
export const AUTHOR_PRIVATE_NOTE_FIXTURE: ResourcePolicy = {
  resourceClass: 'fixture.author_private_note',
  capabilities: ['read', 'create', 'update', 'delete'],
  roleCapabilities: {
    owner: ['read', 'create', 'update', 'delete'],
    gm: ['read', 'create', 'update', 'delete'],
    assistant_gm: ['read', 'create', 'update', 'delete'],
    player: ['read', 'create', 'update', 'delete'],
    observer: [],
  },
  defaultVisibility: 'explicit',
  ownership: {
    field: 'authorUserId',
    capabilities: ['read', 'create', 'update', 'delete'],
    exemptRoles: [],
  },
  sync: {
    kind: 'replicated',
    source: 'fixture_author_private_notes',
    campaignColumn: 'campaign_id',
    visibility: { modeColumn: 'visibility_mode', targetsColumn: 'visibility_targets' },
    deletedAtColumn: 'deleted_at',
    ownershipColumns: { authorUserId: 'author_user_id' },
  },
};
