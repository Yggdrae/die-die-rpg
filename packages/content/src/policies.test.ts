import { describe, expect, test } from 'bun:test';
import {
  AuthorizationService,
  type Capability,
  checkAuthorPrivate,
  KNOWN_ROLES,
  type ResourceFacts,
  type ResourcePolicy,
  ResourcePolicyRegistrationError,
  ResourcePolicyRegistry,
  runPolicyConformance,
  type VisibilityAdapter,
} from '@rpg/authorization';
import type { Role, Visibility } from '@rpg/contracts';
import {
  CAMPAIGN_ENTITY_CLASS,
  CAMPAIGN_ENTITY_POLICY,
  CONTENT_RESOURCE_POLICIES,
  ENTITY_RELATIONSHIP_CLASS,
  ENTITY_RELATIONSHIP_POLICY,
  PERSONAL_NOTE_CLASS,
  PERSONAL_NOTE_POLICY,
} from './policies.ts';
import { CONTENT_CONFIGURATION } from './types.ts';

/** Registration only: the adapter's persistence is proven by the PostgreSQL contract test. */
const stub = (resourceClass: string): VisibilityAdapter => ({
  resourceClass,
  loadFacts: async () => undefined,
  writeVisibility: async () => ({ ok: false, reason: 'not_found' }),
});

function registry(): ResourcePolicyRegistry {
  const value = new ResourcePolicyRegistry({ requireVisibilityAdapters: true });
  value.register(CAMPAIGN_ENTITY_POLICY, stub(CAMPAIGN_ENTITY_CLASS));
  value.register(PERSONAL_NOTE_POLICY);
  value.register(ENTITY_RELATIONSHIP_POLICY, stub(ENTITY_RELATIONSHIP_CLASS));
  return value;
}

const CAMPAIGN = '00000000-0000-4000-8000-000000000c01';
const ACTOR = '00000000-0000-4000-8000-000000000a01';
const OTHER = '00000000-0000-4000-8000-000000000a02';

function facts(
  resourceClass: string,
  visibility: Visibility,
  authorUserId?: string,
): ResourceFacts {
  return {
    campaignId: CAMPAIGN,
    resourceClass,
    resourceId: '00000000-0000-4000-8000-000000000d01',
    visibility,
    version: 1,
    ...(authorUserId === undefined ? {} : { authorUserId }),
  };
}

function allowedRoles(
  resourceClass: string,
  capability: Capability,
  visibility: Visibility,
  authorUserId?: string,
): Role[] {
  const authorization = new AuthorizationService(registry());
  return KNOWN_ROLES.filter(
    (role) =>
      authorization.decide(
        { userId: ACTOR, campaignId: CAMPAIGN, role },
        capability,
        facts(resourceClass, visibility, authorUserId),
      ).allowed,
  );
}

describe('content resource policies register with feature 04 (task 03)', () => {
  test('all three classes register; the reveal-capable classes need their adapters', () => {
    expect(
      registry()
        .policies()
        .map((policy) => policy.resourceClass),
    ).toEqual([CAMPAIGN_ENTITY_CLASS, PERSONAL_NOTE_CLASS, ENTITY_RELATIONSHIP_CLASS]);
    expect(CONTENT_RESOURCE_POLICIES).toEqual([
      CAMPAIGN_ENTITY_POLICY,
      PERSONAL_NOTE_POLICY,
      ENTITY_RELATIONSHIP_POLICY,
    ]);
    for (const policy of [CAMPAIGN_ENTITY_POLICY, ENTITY_RELATIONSHIP_POLICY]) {
      let code: string | undefined;
      try {
        new ResourcePolicyRegistry({ requireVisibilityAdapters: true }).register(policy);
      } catch (error) {
        code = error instanceof ResourcePolicyRegistrationError ? error.code : 'other';
      }
      expect(code).toBe('missing_visibility_adapter');
    }
  });

  test('registration fails if a role row is missing (no default-allow)', () => {
    for (const policy of CONTENT_RESOURCE_POLICIES) {
      for (const role of KNOWN_ROLES) {
        const { [role]: _dropped, ...rows } = policy.roleCapabilities;
        const broken = { ...policy, roleCapabilities: rows } as unknown as ResourcePolicy;
        let code: string | undefined;
        try {
          new ResourcePolicyRegistry().register(broken);
        } catch (error) {
          code = error instanceof ResourcePolicyRegistrationError ? error.code : 'other';
        }
        expect({ class: policy.resourceClass, role, code }).toEqual({
          class: policy.resourceClass,
          role,
          code: 'missing_capability_outcome',
        });
      }
    }
  });

  test('runPolicyConformance passes for both classes; personal notes are author-private', () => {
    for (const resourceClass of [
      CAMPAIGN_ENTITY_CLASS,
      PERSONAL_NOTE_CLASS,
      ENTITY_RELATIONSHIP_CLASS,
    ]) {
      const report = runPolicyConformance(registry(), resourceClass);
      expect(report.cases).toBeGreaterThan(0);
      expect(report.findings).toEqual([]);
    }
    const notes = checkAuthorPrivate(registry(), PERSONAL_NOTE_CLASS);
    expect(notes.cases).toBeGreaterThan(0);
    expect(notes.findings).toEqual([]);
  });
});

describe('decision table (D-04, D-05, D-06)', () => {
  const gmRoles: Role[] = ['owner', 'gm', 'assistant_gm'];

  test('Who may create campaign entities and relationships: every GM role, never player or observer', () => {
    for (const resourceClass of [CAMPAIGN_ENTITY_CLASS, ENTITY_RELATIONSHIP_CLASS]) {
      for (const capability of ['create', 'update', 'delete', 'reveal'] as const) {
        for (const visibility of [
          { mode: 'gm_only' },
          { mode: 'everyone' },
          { mode: 'players', playerIds: [ACTOR] },
        ] as Visibility[]) {
          expect(allowedRoles(resourceClass, capability, visibility)).toEqual(gmRoles);
        }
      }
      expect(allowedRoles(resourceClass, 'read', { mode: 'gm_only' })).toEqual(gmRoles);
      expect(allowedRoles(resourceClass, 'read', { mode: 'everyone' })).toEqual([
        ...gmRoles,
        'player',
      ]);
    }
    expect(ENTITY_RELATIONSHIP_POLICY.defaultVisibility).toEqual({ mode: 'gm_only' });
  });

  test('players read entities only when Visibility admits them; observers never', () => {
    expect(allowedRoles(CAMPAIGN_ENTITY_CLASS, 'read', { mode: 'gm_only' })).toEqual(gmRoles);
    expect(allowedRoles(CAMPAIGN_ENTITY_CLASS, 'read', { mode: 'everyone' })).toEqual([
      ...gmRoles,
      'player',
    ]);
    expect(
      allowedRoles(CAMPAIGN_ENTITY_CLASS, 'read', { mode: 'players', playerIds: [ACTOR] }),
    ).toEqual([...gmRoles, 'player']);
    expect(
      allowedRoles(CAMPAIGN_ENTITY_CLASS, 'read', { mode: 'players', playerIds: [OTHER] }),
    ).toEqual(gmRoles);
  });

  test('Nobody else reads a personal note: GM roles denied every capability, another player denied', () => {
    const own: Visibility = { mode: 'players', playerIds: [ACTOR] };
    for (const capability of ['read', 'create', 'update', 'delete'] as const) {
      expect(allowedRoles(PERSONAL_NOTE_CLASS, capability, own, ACTOR)).toEqual(['player']);
      // Another player's note (author OTHER, visibility players:[OTHER]); even players:[ACTOR]
      // with a foreign author is denied by the Ownership Rule.
      expect(
        allowedRoles(
          PERSONAL_NOTE_CLASS,
          capability,
          { mode: 'players', playerIds: [OTHER] },
          OTHER,
        ),
      ).toEqual([]);
      expect(allowedRoles(PERSONAL_NOTE_CLASS, capability, own, OTHER)).toEqual([]);
    }
    expect(allowedRoles(PERSONAL_NOTE_CLASS, 'reveal', own, ACTOR)).toEqual([]);
  });

  test('GM-only default for every enabled type (FR-010, BR-002)', () => {
    // One class serves every type, so the default is the class default for each of them.
    for (const definition of CONTENT_CONFIGURATION.types.filter((item) => item.enabled)) {
      const policy = registry().get(CAMPAIGN_ENTITY_CLASS);
      expect({ type: definition.id, default: policy?.defaultVisibility }).toEqual({
        type: definition.id,
        default: { mode: 'gm_only' },
      });
    }
    expect(allowedRoles(CAMPAIGN_ENTITY_CLASS, 'read', { mode: 'gm_only' })).not.toContain(
      'player',
    );
    expect(PERSONAL_NOTE_POLICY.defaultVisibility).toBe('explicit');
    expect(CAMPAIGN_ENTITY_POLICY.revealTargets).toEqual(['players']);
  });
});
