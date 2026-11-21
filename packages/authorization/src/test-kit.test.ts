import { describe, expect, test } from 'bun:test';
import type { ActorRef, Role, Visibility } from '@rpg/contracts';
import {
  AUTHOR_PRIVATE_NOTE_FIXTURE,
  AuthorizationService,
  checkAuthorPrivate,
  conformanceCases,
  type ResourcePolicy,
  ResourcePolicyRegistry,
  runPolicyConformance,
  SyncPredicateCompiler,
} from './index.ts';

const CAMPAIGN = '00000000-0000-4000-8000-000000000001';
const AUTHOR = '00000000-0000-4000-8000-0000000000a1';
const GM_USER = '00000000-0000-4000-8000-0000000000a2';
const NOTE = AUTHOR_PRIVATE_NOTE_FIXTURE.resourceClass;

function noteRegistry() {
  const registry = new ResourcePolicyRegistry();
  registry.register(AUTHOR_PRIVATE_NOTE_FIXTURE);
  return registry;
}

function actor(role: Role, userId: string): ActorRef {
  return { userId, campaignId: CAMPAIGN, role };
}

const EVERYONE: Visibility = { mode: 'everyone' };
const AUTHOR_ONLY: Visibility = { mode: 'players', playerIds: [AUTHOR] };
const visibilities: readonly Visibility[] = [
  { mode: 'everyone' },
  { mode: 'gm_only' },
  { mode: 'players', playerIds: [AUTHOR] },
  { mode: 'players', playerIds: [AUTHOR, GM_USER] },
];

function note(visibility: Visibility) {
  return {
    campaignId: CAMPAIGN,
    resourceClass: NOTE,
    resourceId: '00000000-0000-4000-8000-0000000000d1',
    visibility,
    version: 3,
    authorUserId: AUTHOR,
  };
}

describe('author-private note conformance fixture', () => {
  test('A player-authored private note is not readable by a GM role', () => {
    const registry = noteRegistry();
    const authorization = new AuthorizationService(registry);
    const predicate = new SyncPredicateCompiler(registry).compile(NOTE);
    for (const role of ['owner', 'gm', 'assistant_gm', 'player', 'observer'] as const) {
      for (const visibility of visibilities) {
        for (const capability of AUTHOR_PRIVATE_NOTE_FIXTURE.capabilities) {
          const decision = authorization.decide(actor(role, GM_USER), capability, note(visibility));
          expect(decision.allowed).toBe(false);
        }
        // Absent from that actor's local database.
        expect(predicate.matches(actor(role, GM_USER), note(visibility))).toBe(false);
      }
    }
  });

  test('the player author keeps access when the Visibility includes them', () => {
    const registry = noteRegistry();
    const authorization = new AuthorizationService(registry);
    const predicate = new SyncPredicateCompiler(registry).compile(NOTE);
    const author = actor('player', AUTHOR);
    for (const visibility of [EVERYONE, AUTHOR_ONLY]) {
      expect(authorization.decide(author, 'read', note(visibility))).toEqual({
        allowed: true,
        reason: 'allowed_by_policy',
      });
      expect(predicate.matches(author, note(visibility))).toBe(true);
    }
    expect(
      authorization.decide({ ...author, campaignId: crypto.randomUUID() }, 'read', note(EVERYONE))
        .allowed,
    ).toBe(false);
  });

  test('a non-author is denied with the ownership reason, collapsed publicly elsewhere', () => {
    const decision = new AuthorizationService(noteRegistry()).decide(
      actor('gm', GM_USER),
      'read',
      note({ mode: 'everyone' }),
    );
    expect(decision).toEqual({ allowed: false, reason: 'ownership_denied' });
  });

  test('the sync declaration carries the ownership column and no role override', () => {
    const { declaration } = new SyncPredicateCompiler(noteRegistry()).compile(NOTE);
    expect(declaration.ownership).toEqual({ field: 'authorUserId', exemptRoles: [] });
    expect(declaration.source?.ownershipColumns?.authorUserId).toBe('author_user_id');
  });

  test('checkAuthorPrivate passes the fixture and flags a GM-role override', () => {
    const report = checkAuthorPrivate(noteRegistry(), NOTE);
    expect(report.findings).toEqual([]);
    expect(report.cases).toBeGreaterThan(0);

    const leaky = new ResourcePolicyRegistry();
    leaky.register({
      ...AUTHOR_PRIVATE_NOTE_FIXTURE,
      ownership: {
        field: 'authorUserId',
        capabilities: AUTHOR_PRIVATE_NOTE_FIXTURE.capabilities,
        exemptRoles: ['gm'],
      },
    });
    const problems = new Set(checkAuthorPrivate(leaky, NOTE).findings.map((f) => f.problem));
    expect(problems).toEqual(new Set(['not_author_private', 'ownership_bypassed']));
  });
});

describe('shared matrix conformance', () => {
  test('Every content-owning class runs the shared matrix: fixture has no findings', () => {
    const report = runPolicyConformance(noteRegistry(), NOTE);
    // 5 roles x 4 capabilities x 6 Visibility samples x 2 campaigns x 3 author facts.
    expect(report.cases).toBe(720);
    expect(report.findings).toEqual([]);
  });

  test('Both rules come from one declaration: a GM-prep class with party active agrees', () => {
    const registry = new ResourcePolicyRegistry({ partyTargeting: 'active' });
    registry.register({
      resourceClass: 'prep_note',
      capabilities: ['read', 'update', 'reveal'],
      roleCapabilities: {
        owner: ['read', 'update', 'reveal'],
        gm: ['read', 'update', 'reveal'],
        assistant_gm: ['read', 'reveal'],
        player: ['read'],
        observer: [],
      },
      defaultVisibility: { mode: 'gm_only' },
      revealTargets: ['players', 'party'],
      sync: {
        kind: 'replicated',
        source: 'prep_notes',
        campaignColumn: 'campaign_id',
        visibility: { modeColumn: 'visibility_mode', targetsColumn: 'visibility_targets' },
        deletedAtColumn: 'deleted_at',
      },
    });
    const report = runPolicyConformance(registry, 'prep_note');
    expect(report.cases).toBe(conformanceCases(registry.policies()[0] as ResourcePolicy).length);
    expect(report.findings).toEqual([]);
  });

  test('an unregistered class fails the kit instead of passing vacuously', () => {
    expect(() => runPolicyConformance(new ResourcePolicyRegistry(), 'missing')).toThrow(
      'unregistered_resource_class',
    );
  });
});
