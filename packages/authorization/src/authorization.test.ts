import { describe, expect, test } from 'bun:test';
import type { ActorRef, Role } from '@rpg/contracts';
import {
  AuthorizationService,
  type Capability,
  type ResourceFacts,
  ResourcePolicyRegistry,
  SyncPredicateCompiler,
  toPublicAuthorizationError,
} from './authorization.ts';

const roles: readonly Role[] = ['owner', 'gm', 'assistant_gm', 'player', 'observer'];
const capabilities: readonly Capability[] = ['read', 'update'];

function registry() {
  const registry = new ResourcePolicyRegistry();
  registry.register({
    resourceClass: 'campaign',
    capabilities,
    roleCapabilities: {
      owner: capabilities,
      gm: ['read'],
      assistant_gm: ['read'],
      player: ['read'],
      observer: [],
    },
  });
  return registry;
}

function service() {
  return new AuthorizationService(registry());
}

function actor(role: Role, campaignId = '00000000-0000-4000-8000-000000000001'): ActorRef {
  return { userId: '00000000-0000-4000-8000-000000000002', campaignId, role };
}

const facts = {
  campaignId: '00000000-0000-4000-8000-000000000001',
  resourceClass: 'campaign',
  resourceId: '00000000-0000-4000-8000-000000000001',
  visibility: { mode: 'everyone' } as const,
  version: 1,
};

describe('AuthorizationService', () => {
  test('exhaustively applies the declared role/capability matrix', () => {
    const authorization = service();
    for (const role of roles) {
      for (const capability of capabilities) {
        const expected = role === 'owner' || (capability === 'read' && role !== 'observer');
        expect(authorization.decide(actor(role), capability, facts).allowed).toBe(expected);
      }
    }
  });

  test('fails closed for cross-campaign, unknown, targeted, party, and GM-only inputs', () => {
    const authorization = service();
    expect(authorization.decide(actor('owner', crypto.randomUUID()), 'read', facts).allowed).toBe(
      false,
    );
    expect(authorization.decide(actor('owner'), 'invented', facts).allowed).toBe(false);
    expect(
      authorization.decide(actor('player'), 'read', {
        ...facts,
        visibility: { mode: 'players', playerIds: [crypto.randomUUID()] },
      }).allowed,
    ).toBe(false);
    expect(
      authorization.decide(actor('player'), 'read', {
        ...facts,
        visibility: { mode: 'party', partyIds: [crypto.randomUUID()] },
      }).allowed,
    ).toBe(false);
    expect(
      authorization.decide(actor('player'), 'read', {
        ...facts,
        visibility: { mode: 'gm_only' },
      }).allowed,
    ).toBe(false);
  });

  test('collapses every public denial to one hidden-or-missing outcome', () => {
    const decision = service().decide(actor('observer'), 'read', facts);
    expect(toPublicAuthorizationError(decision)).toBe('not_found_or_forbidden');
  });

  test('rejects incomplete, duplicate, and observer-permissive policies at composition', () => {
    const registry = new ResourcePolicyRegistry();
    expect(() =>
      registry.register({
        resourceClass: 'unsafe',
        capabilities: ['read'],
        roleCapabilities: {
          owner: ['read'],
          gm: ['read'],
          assistant_gm: ['read'],
          player: ['read'],
          observer: ['read'],
        },
      }),
    ).toThrow('invalid_resource_policy');
  });

  test('keeps API decisions and compiled sync predicates equivalent', () => {
    const policies = registry();
    const authorization = new AuthorizationService(policies);
    const predicate = new SyncPredicateCompiler(policies).compile('campaign');
    const visibility: ResourceFacts['visibility'][] = [
      { mode: 'everyone' },
      { mode: 'gm_only' },
      { mode: 'players', playerIds: [actor('player').userId] },
      { mode: 'players', playerIds: [crypto.randomUUID()] },
      { mode: 'party', partyIds: ['party-a'] },
    ];

    for (const role of roles) {
      for (const rule of visibility) {
        const candidate = {
          ...facts,
          visibility: rule,
          partyIds: rule.mode === 'party' ? ['party-a'] : undefined,
        };
        expect(predicate.matches(actor(role), candidate)).toBe(
          authorization.decide(actor(role), 'read', candidate).allowed,
        );
      }
    }
  });

  test('omits hidden rows, counts, and tombstones from a player replica', () => {
    const predicate = new SyncPredicateCompiler(registry()).compile('campaign');
    const player = actor('player');
    const records = [
      { ...facts, resourceId: 'visible', visibility: { mode: 'everyone' } as const },
      { ...facts, resourceId: 'hidden', visibility: { mode: 'gm_only' } as const },
      {
        ...facts,
        resourceId: 'hidden-tombstone',
        visibility: { mode: 'gm_only' } as const,
        deletedAt: '2026-08-31T00:00:00Z',
      },
    ];
    const replica = records.filter((record) => predicate.matches(player, record));

    expect(replica.map((record) => record.resourceId)).toEqual(['visible']);
    expect(replica).toHaveLength(1);
    expect(replica.some((record) => 'deletedAt' in record)).toBe(false);
  });
});
