import { describe, expect, test } from 'bun:test';
import type { ActorRef } from '@rpg/contracts';
import {
  AuthorizationService,
  type RegistrationFailure,
  type ResourceFacts,
  type ResourcePolicy,
  ResourcePolicyRegistrationError,
  ResourcePolicyRegistry,
  type ResourcePolicyRegistryOptions,
  SyncPredicateCompiler,
  type VisibilityAdapter,
} from './index.ts';

const CAMPAIGN = '00000000-0000-4000-8000-000000000001';
const PARTY = '00000000-0000-4000-8000-0000000000b1';

function prepPolicy(overrides: Partial<ResourcePolicy> = {}): ResourcePolicy {
  return {
    resourceClass: 'prep_note',
    capabilities: ['read', 'create', 'update', 'reveal'],
    roleCapabilities: {
      owner: ['read', 'create', 'update', 'reveal'],
      gm: ['read', 'create', 'update', 'reveal'],
      assistant_gm: ['read', 'create', 'update', 'reveal'],
      player: ['read'],
      observer: [],
    },
    defaultVisibility: { mode: 'gm_only' },
    sync: {
      kind: 'replicated',
      source: 'prep_notes',
      campaignColumn: 'campaign_id',
      visibility: { modeColumn: 'visibility_mode', targetsColumn: 'visibility_targets' },
      deletedAtColumn: 'deleted_at',
    },
    ...overrides,
  };
}

function adapter(resourceClass = 'prep_note'): VisibilityAdapter {
  return {
    resourceClass,
    loadFacts: async () => undefined,
    writeVisibility: async () => ({ ok: false, reason: 'not_found' }),
  };
}

function rejection(
  register: (registry: ResourcePolicyRegistry) => void,
  options?: ResourcePolicyRegistryOptions,
): RegistrationFailure | undefined {
  const registry = new ResourcePolicyRegistry(options);
  try {
    register(registry);
    return undefined;
  } catch (error) {
    expect(error).toBeInstanceOf(ResourcePolicyRegistrationError);
    expect((error as Error).message).toContain('invalid_resource_policy');
    return (error as ResourcePolicyRegistrationError).code;
  }
}

function rejects(policy: unknown, options?: ResourcePolicyRegistryOptions) {
  let registry: ResourcePolicyRegistry | undefined;
  const code = rejection((created) => {
    registry = created;
    created.register(policy as ResourcePolicy);
  }, options);
  // A rejected declaration leaves nothing registered.
  if (code !== undefined) expect(registry?.policies()).toHaveLength(0);
  return code;
}

describe('ResourcePolicyRegistry startup validation', () => {
  test('registers a complete declaration and exposes it with its adapter', () => {
    const registry = new ResourcePolicyRegistry({ requireVisibilityAdapters: true });
    const owned = adapter();
    registry.register(prepPolicy(), owned);
    expect(registry.get('prep_note')?.resourceClass).toBe('prep_note');
    expect(registry.adapterFor('prep_note')).toBe(owned);
    expect(registry.policies()).toHaveLength(1);
    expect(registry.get('unknown')).toBeUndefined();
  });

  test('rejects duplicate and blank class identifiers', () => {
    expect(
      rejection((registry) => {
        registry.register(prepPolicy());
        registry.register(prepPolicy());
      }),
    ).toBe('duplicate_resource_class');
    expect(rejects(prepPolicy({ resourceClass: ' ' }))).toBe('invalid_resource_class');
  });

  test('missing capability rows prevent registration instead of defaulting allow', () => {
    const { player: _player, ...withoutPlayer } = prepPolicy().roleCapabilities;
    expect(rejects({ ...prepPolicy(), roleCapabilities: withoutPlayer })).toBe(
      'missing_capability_outcome',
    );
    const { observer: _observer, ...withoutObserver } = prepPolicy().roleCapabilities;
    expect(rejects({ ...prepPolicy(), roleCapabilities: withoutObserver })).toBe(
      'missing_capability_outcome',
    );
    expect(
      rejects({
        ...prepPolicy(),
        roleCapabilities: { ...prepPolicy().roleCapabilities, admin: ['read'] },
      }),
    ).toBe('unknown_role');
    expect(
      rejects(
        prepPolicy({
          roleCapabilities: { ...prepPolicy().roleCapabilities, player: ['read', 'export'] },
        }),
      ),
    ).toBe('undeclared_capability');
    expect(rejects(prepPolicy({ capabilities: [] }))).toBe('invalid_capabilities');
    expect(rejects(prepPolicy({ capabilities: ['read', 'read'] }))).toBe('invalid_capabilities');
  });

  test('rejects observer capabilities and player reveal', () => {
    expect(
      rejects(
        prepPolicy({ roleCapabilities: { ...prepPolicy().roleCapabilities, observer: ['read'] } }),
      ),
    ).toBe('observer_capability');
    // _bdd.md: A player cannot change what anyone may see.
    expect(
      rejects(
        prepPolicy({
          roleCapabilities: { ...prepPolicy().roleCapabilities, player: ['read', 'reveal'] },
        }),
      ),
    ).toBe('player_reveal');
  });

  test('requires a default Visibility or an explicit-visibility requirement', () => {
    const { defaultVisibility: _default, ...withoutDefault } = prepPolicy();
    expect(rejects(withoutDefault)).toBe('missing_default_visibility');
    expect(
      rejects(prepPolicy({ defaultVisibility: { mode: 'players', playerIds: [CAMPAIGN] } })),
    ).toBe('invalid_default_visibility');
    expect(rejects(prepPolicy({ defaultVisibility: 'explicit' }))).toBeUndefined();
  });

  test('rejects an absent or malformed sync predicate declaration', () => {
    const { sync: _sync, ...withoutSync } = prepPolicy();
    expect(rejects(withoutSync)).toBe('missing_sync_predicate');
    expect(rejects({ ...prepPolicy(), sync: { kind: 'later' } })).toBe('invalid_sync_predicate');
    expect(
      rejects(
        prepPolicy({
          sync: {
            kind: 'replicated',
            source: '',
            campaignColumn: 'campaign_id',
            visibility: { modeColumn: 'visibility_mode', targetsColumn: 'visibility_targets' },
            deletedAtColumn: null,
          },
        }),
      ),
    ).toBe('invalid_sync_predicate');
    expect(rejects(prepPolicy({ sync: { kind: 'server_only' } }))).toBeUndefined();
  });

  test('campaign-wide rows must mean everyone and cannot be revealed', () => {
    const campaignWide = {
      kind: 'replicated',
      source: 'campaigns',
      campaignColumn: 'id',
      visibility: 'campaign_wide',
      deletedAtColumn: 'deleted_at',
    } as const;
    expect(rejects(prepPolicy({ sync: campaignWide }))).toBe('campaign_wide_requires_everyone');
    expect(
      rejects(
        prepPolicy({
          sync: campaignWide,
          defaultVisibility: { mode: 'everyone' },
          capabilities: ['read'],
          roleCapabilities: {
            owner: ['read'],
            gm: ['read'],
            assistant_gm: ['read'],
            player: ['read'],
            observer: [],
          },
        }),
      ),
    ).toBeUndefined();
  });

  test('ownership predicates are validated and need a sync ownership column for reads', () => {
    expect(
      rejects(
        prepPolicy({
          ownership: { field: 'authorUserId', capabilities: ['read'], exemptRoles: [] },
        }),
      ),
    ).toBe('missing_ownership_column');
    expect(
      rejects(
        prepPolicy({
          ownership: { field: 'authorUserId', capabilities: ['export'], exemptRoles: [] },
        }),
      ),
    ).toBe('invalid_ownership_rule');
    expect(
      rejects(
        prepPolicy({
          ownership: { field: 'authorUserId', capabilities: ['update'], exemptRoles: ['observer'] },
        }),
      ),
    ).toBe('invalid_ownership_rule');
    expect(
      rejects(
        prepPolicy({
          ownership: { field: 'authorUserId', capabilities: ['update'], exemptRoles: ['gm'] },
        }),
      ),
    ).toBeUndefined();
  });

  test('rejects party targeting while no party resolver is active', () => {
    expect(rejects(prepPolicy({ revealTargets: ['players', 'party'] }))).toBe(
      'party_targeting_inactive',
    );
    expect(
      rejects(prepPolicy({ revealTargets: ['players', 'party'] }), { partyTargeting: 'active' }),
    ).toBeUndefined();
    expect(rejects(prepPolicy({ revealTargets: [] }))).toBe('invalid_reveal_targets');
    expect(
      rejects(
        prepPolicy({
          revealTargets: ['players'],
          capabilities: ['read'],
          roleCapabilities: {
            owner: ['read'],
            gm: ['read'],
            assistant_gm: ['read'],
            player: ['read'],
            observer: [],
          },
        }),
      ),
    ).toBe('invalid_reveal_targets');
  });

  test('rejects incompatible or missing visibility adapters', () => {
    expect(rejection((registry) => registry.register(prepPolicy(), adapter('other')))).toBe(
      'incompatible_adapter',
    );
    expect(
      rejection((registry) =>
        registry.register(prepPolicy(), {
          resourceClass: 'prep_note',
        } as unknown as VisibilityAdapter),
      ),
    ).toBe('incompatible_adapter');
    expect(
      rejection((registry) =>
        registry.register(
          prepPolicy({
            capabilities: ['read'],
            roleCapabilities: {
              owner: ['read'],
              gm: ['read'],
              assistant_gm: ['read'],
              player: ['read'],
              observer: [],
            },
          }),
          adapter(),
        ),
      ),
    ).toBe('incompatible_adapter');
    expect(rejects(prepPolicy(), { requireVisibilityAdapters: true })).toBe(
      'missing_visibility_adapter',
    );
    expect(rejects(prepPolicy())).toBeUndefined();
  });
});

describe('party Visibility fails closed until a resolver is active', () => {
  const player: ActorRef = {
    userId: '00000000-0000-4000-8000-000000000002',
    campaignId: CAMPAIGN,
    role: 'player',
  };
  const facts: ResourceFacts = {
    campaignId: CAMPAIGN,
    resourceClass: 'prep_note',
    resourceId: '00000000-0000-4000-8000-0000000000d1',
    visibility: { mode: 'party', partyIds: [PARTY] },
    version: 1,
    partyIds: [PARTY],
  };

  test('inactive: party members and GM roles are denied by API and sync alike', () => {
    const registry = new ResourcePolicyRegistry();
    registry.register(prepPolicy());
    const predicate = new SyncPredicateCompiler(registry).compile('prep_note');
    for (const role of ['owner', 'gm', 'player'] as const) {
      const decision = new AuthorizationService(registry).decide(
        { ...player, role },
        'read',
        facts,
      );
      expect(decision).toEqual({ allowed: false, reason: 'party_unresolved' });
      expect(predicate.matches({ ...player, role }, facts)).toBe(false);
    }
  });

  test('active: a party member is allowed, a non-member denied, API and sync agree', () => {
    const registry = new ResourcePolicyRegistry({ partyTargeting: 'active' });
    registry.register(prepPolicy({ revealTargets: ['players', 'party'] }));
    const authorization = new AuthorizationService(registry);
    const predicate = new SyncPredicateCompiler(registry).compile('prep_note');
    expect(authorization.decide(player, 'read', facts).allowed).toBe(true);
    expect(predicate.matches(player, facts)).toBe(true);
    const outsider = { ...facts, partyIds: [] };
    expect(authorization.decide(player, 'read', outsider).allowed).toBe(false);
    expect(predicate.matches(player, outsider)).toBe(false);
  });
});
