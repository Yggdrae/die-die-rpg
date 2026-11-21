import { describe, expect, test } from 'bun:test';
import {
  AUTHOR_PRIVATE_NOTE_FIXTURE,
  evaluateSyncRule,
  findSyncDivergences,
  type ReplicatedSync,
  type ResourcePolicy,
  ResourcePolicyRegistry,
  rowPredicate,
  type SyncPredicate,
  SyncPredicateCompiler,
  type SyncRule,
  simplify,
  syncTruthTable,
  truthRequester,
} from './index.ts';

/**
 * Feature 04 task 05: the provider-neutral sync predicate AST and the exhaustive API-vs-sync
 * truth table (`_bdd.md`, Sync Rules and API Rules Agree).
 */

const columns = { modeColumn: 'visibility_mode', targetsColumn: 'visibility_targets' } as const;

const HANDOUT: ResourcePolicy = {
  resourceClass: 'fixture.handout',
  capabilities: ['read', 'update', 'reveal'],
  roleCapabilities: {
    owner: ['read', 'update', 'reveal'],
    gm: ['read', 'update', 'reveal'],
    assistant_gm: ['read', 'update', 'reveal'],
    player: ['read'],
    observer: [],
  },
  defaultVisibility: { mode: 'gm_only' },
  sync: {
    kind: 'replicated',
    source: 'fixture_handouts',
    campaignColumn: 'campaign_id',
    visibility: columns,
    deletedAtColumn: 'deleted_at',
  },
};

/** Ownership covering `read` with a partial GM-role exemption (assistant GM not exempt). */
const OWNED_PREP: ResourcePolicy = {
  resourceClass: 'fixture.owned_prep',
  capabilities: ['read', 'update'],
  roleCapabilities: {
    owner: ['read', 'update'],
    gm: ['read', 'update'],
    assistant_gm: ['read'],
    player: ['read', 'update'],
    observer: [],
  },
  defaultVisibility: 'explicit',
  ownership: {
    field: 'authorUserId',
    capabilities: ['read', 'update'],
    exemptRoles: ['owner', 'gm'],
  },
  sync: {
    kind: 'replicated',
    source: 'fixture_owned_prep',
    campaignColumn: 'campaign_id',
    visibility: columns,
    deletedAtColumn: 'deleted_at',
    ownershipColumns: { authorUserId: 'author_user_id' },
  },
};

/** Players hold no `read`, whatever the Visibility. */
const GM_SECRET: ResourcePolicy = {
  resourceClass: 'fixture.gm_secret',
  capabilities: ['read'],
  roleCapabilities: { owner: ['read'], gm: ['read'], assistant_gm: [], player: [], observer: [] },
  defaultVisibility: { mode: 'gm_only' },
  sync: {
    kind: 'replicated',
    source: 'fixture_gm_secrets',
    campaignColumn: 'campaign_id',
    visibility: columns,
    deletedAtColumn: null,
  },
};

const CAMPAIGN_WIDE: ResourcePolicy = {
  resourceClass: 'fixture.campaign_wide',
  capabilities: ['read', 'update'],
  roleCapabilities: {
    owner: ['read', 'update'],
    gm: ['read'],
    assistant_gm: ['read'],
    player: ['read'],
    observer: [],
  },
  defaultVisibility: { mode: 'everyone' },
  sync: {
    kind: 'replicated',
    source: 'fixture_campaign_rows',
    campaignColumn: 'id',
    visibility: 'campaign_wide',
    deletedAtColumn: 'deleted_at',
  },
};

const SERVER_ONLY: ResourcePolicy = {
  resourceClass: 'fixture.server_only',
  capabilities: ['read'],
  roleCapabilities: {
    owner: ['read'],
    gm: ['read'],
    assistant_gm: ['read'],
    player: ['read'],
    observer: [],
  },
  defaultVisibility: { mode: 'everyone' },
  sync: { kind: 'server_only' },
};

const CLASSES = [HANDOUT, OWNED_PREP, GM_SECRET, CAMPAIGN_WIDE, AUTHOR_PRIVATE_NOTE_FIXTURE];

function registry(partyTargeting: 'inactive' | 'active' = 'inactive'): ResourcePolicyRegistry {
  const value = new ResourcePolicyRegistry({ partyTargeting });
  for (const policy of [...CLASSES, SERVER_ONLY]) value.register(policy);
  return value;
}

function ruleOf(policy: ResourcePolicy, partyTargeting: 'inactive' | 'active' = 'inactive') {
  return new SyncPredicateCompiler(registry(partyTargeting)).compile(policy.resourceClass).rule;
}

const GM = ['owner', 'gm', 'assistant_gm'] as const;
const READERS = ['owner', 'gm', 'assistant_gm', 'player'] as const;

describe('sync predicate AST', () => {
  test('a targeted class compiles to campaign scope, roles, and the Visibility branches', () => {
    expect(ruleOf(HANDOUT)).toEqual({
      resourceClass: 'fixture.handout',
      capability: 'read',
      source: HANDOUT.sync as ReplicatedSync,
      tombstones: 'same_predicate',
      predicate: {
        kind: 'and',
        of: [
          { kind: 'member_role_in', roles: [...READERS] },
          {
            kind: 'or',
            of: [
              { kind: 'visibility_mode_in', modes: ['everyone'] },
              {
                kind: 'and',
                of: [
                  { kind: 'visibility_mode_in', modes: ['players'] },
                  { kind: 'targets_include_requester' },
                ],
              },
              {
                kind: 'and',
                of: [
                  { kind: 'member_role_in', roles: [...GM] },
                  { kind: 'visibility_mode_in', modes: ['gm_only', 'players'] },
                ],
              },
            ],
          },
        ],
      },
    });
  });

  test('a campaign-wide class folds to current membership with a reading role', () => {
    const rule = ruleOf(CAMPAIGN_WIDE);
    // The AST keeps the Visibility clause (decide-equivalent on any facts) ...
    expect(rule.predicate.kind === 'and' && rule.predicate.of.length).toBe(2);
    // ... and folds it away for rows that are `everyone` by declaration.
    expect(rowPredicate(rule)).toEqual({ kind: 'member_role_in', roles: [...READERS] });
    expect(rowPredicate(ruleOf(SERVER_ONLY))).toEqual({ kind: 'never' });
  });

  test('simplify preserves truth values and flattens constants', () => {
    const role = { kind: 'member_role_in', roles: ['gm'] } as const;
    expect(simplify({ kind: 'and', of: [{ kind: 'always' }, role] })).toEqual(role);
    expect(simplify({ kind: 'and', of: [{ kind: 'never' }, role] })).toEqual({ kind: 'never' });
    expect(simplify({ kind: 'or', of: [{ kind: 'always' }, role] })).toEqual({ kind: 'always' });
    expect(simplify({ kind: 'or', of: [] })).toEqual({ kind: 'never' });
    expect(simplify({ kind: 'and', of: [{ kind: 'and', of: [role, role] }, role] })).toEqual({
      kind: 'and',
      of: [role, role, role],
    });
    // A targeted class is already minimal.
    expect(rowPredicate(ruleOf(HANDOUT))).toEqual(ruleOf(HANDOUT).predicate);
  });

  test('author-private ownership has no GM-role override; a partial exemption keeps it narrow', () => {
    const notes = ruleOf(AUTHOR_PRIVATE_NOTE_FIXTURE).predicate;
    expect(notes.kind === 'and' && notes.of[1]).toEqual({
      kind: 'owner_is_requester',
      field: 'authorUserId',
    });
    const prep = ruleOf(OWNED_PREP).predicate;
    expect(prep.kind === 'and' && prep.of[1]).toEqual({
      kind: 'or',
      of: [
        { kind: 'member_role_in', roles: ['owner', 'gm'] },
        { kind: 'owner_is_requester', field: 'authorUserId' },
      ],
    });
  });

  test('server-only classes and classes without a reading role compile to never', () => {
    expect(ruleOf(SERVER_ONLY)).toMatchObject({ predicate: { kind: 'never' } });
    expect(ruleOf(SERVER_ONLY).source).toBeUndefined();
    const noReaders = new ResourcePolicyRegistry();
    noReaders.register({
      ...GM_SECRET,
      resourceClass: 'fixture.no_readers',
      capabilities: ['read', 'update'],
      roleCapabilities: { owner: ['update'], gm: [], assistant_gm: [], player: [], observer: [] },
    });
    expect(
      new SyncPredicateCompiler(noReaders).compile('fixture.no_readers').rule.predicate,
    ).toEqual({ kind: 'never' });
    // Only the reading roles are scoped in.
    const secret = ruleOf(GM_SECRET).predicate;
    expect(secret.kind === 'and' && secret.of[0]).toEqual({
      kind: 'member_role_in',
      roles: ['owner', 'gm'],
    });
  });

  test('party predicates only appear while party targeting is active', () => {
    const inactive = JSON.stringify(ruleOf(HANDOUT));
    expect(inactive).not.toContain('party');
    const active = JSON.stringify(ruleOf(HANDOUT, 'active'));
    expect(active).toContain('party_includes_requester');
  });

  test('rules() compiles every registered class in registration order', () => {
    const rules = new SyncPredicateCompiler(registry()).rules();
    expect(rules.map((rule) => rule.resourceClass)).toEqual([
      ...CLASSES.map((policy) => policy.resourceClass),
      SERVER_ONLY.resourceClass,
    ]);
  });
});

describe('Both rules come from one declaration: exhaustive API-vs-sync truth table', () => {
  for (const policy of CLASSES) {
    test(`${policy.resourceClass}: the AST agrees with decide on every case`, () => {
      const table = syncTruthTable(registry(), policy.resourceClass);
      expect(table.requesters.map((item) => item.label)).toEqual([
        'owner',
        'gm',
        'assistant_gm',
        'player',
        'observer',
        'second_player',
        'removed_gm',
        'non_member',
        'other_campaign_gm',
      ]);
      expect(table.cases.length).toBe(table.requesters.length * table.rows.length);
      expect(findSyncDivergences(table)).toEqual([]);
      // Non-trivial: some cases sync and some do not.
      expect(table.cases.some((item) => item.synced)).toBe(true);
      expect(table.cases.some((item) => !item.synced)).toBe(true);
    });
  }

  test('the matrix covers modes, targets, authors, tombstones, and both campaigns', () => {
    const table = syncTruthTable(registry(), HANDOUT.resourceClass);
    // 2 campaigns x 13 Visibility samples x 10 author facts x live/tombstone.
    expect(table.rows.length).toBe(2 * 13 * 10 * 2);
    expect(table.cases.length).toBe(9 * 520);
  });

  test('observer, removed member, non-member and other-campaign member never sync a row', () => {
    for (const policy of CLASSES) {
      const table = syncTruthTable(registry(), policy.resourceClass);
      const outsiders = ['observer', 'removed_gm', 'non_member'];
      for (const item of table.cases) {
        if (outsiders.includes(item.requester.label)) expect(item.synced).toBe(false);
        if (
          item.requester.label === 'other_campaign_gm' &&
          item.row.facts.campaignId === table.campaignId
        ) {
          expect(item.synced).toBe(false);
        }
      }
    }
  });

  test('a divergent rule fails the suite (mutations are detected)', () => {
    const mutate = (rule: SyncRule, change: (predicate: SyncPredicate) => SyncPredicate) => ({
      ...rule,
      predicate: change(rule.predicate),
    });
    const and = (predicate: SyncPredicate) => (predicate.kind === 'and' ? predicate.of : []);
    const mutations: {
      policy: ResourcePolicy;
      name: string;
      change: (p: SyncPredicate) => SyncPredicate;
    }[] = [
      {
        policy: HANDOUT,
        name: 'drop role scope',
        change: (p) => ({ kind: 'and', of: and(p).slice(1) }),
      },
      { policy: HANDOUT, name: 'drop Visibility', change: (p) => and(p)[0] as SyncPredicate },
      {
        policy: HANDOUT,
        name: 'GM roles see party',
        change: (p) =>
          JSON.parse(
            JSON.stringify(p).replace('["gm_only","players"]', '["gm_only","players","party"]'),
          ),
      },
      {
        policy: AUTHOR_PRIVATE_NOTE_FIXTURE,
        name: 'GM-role override on author-private',
        change: (p) => ({
          kind: 'and',
          of: and(p).map((item) =>
            item.kind === 'owner_is_requester'
              ? { kind: 'or', of: [{ kind: 'member_role_in', roles: [...GM] }, item] }
              : item,
          ),
        }),
      },
      {
        policy: OWNED_PREP,
        name: 'drop ownership',
        change: (p) => ({ kind: 'and', of: and(p).filter((_item, index) => index !== 1) }),
      },
      {
        policy: CAMPAIGN_WIDE,
        name: 'admit observers',
        change: () => ({ kind: 'member_role_in', roles: [...READERS, 'observer'] }),
      },
    ];
    for (const { policy, name, change } of mutations) {
      const table = syncTruthTable(registry(), policy.resourceClass);
      const mutated = mutate(table.rule, change);
      const divergences = findSyncDivergences(table, (requester, row) =>
        evaluateSyncRule(mutated, truthRequester(requester), row.facts),
      );
      expect({ name, detected: divergences.length > 0 }).toEqual({ name, detected: true });
    }
  });
});

describe('Party predicates deny until a resolver registers', () => {
  test('inactive: no requester syncs a party row, GM roles included', () => {
    const table = syncTruthTable(registry(), HANDOUT.resourceClass);
    const party = table.cases.filter((item) => item.row.facts.visibility.mode === 'party');
    expect(party.length).toBeGreaterThan(0);
    expect(party.every((item) => !item.synced && !item.api)).toBe(true);
  });

  test('active: GM roles sync party rows and the truth table still agrees', () => {
    const table = syncTruthTable(registry('active'), HANDOUT.resourceClass);
    expect(findSyncDivergences(table)).toEqual([]);
    const gmParty = table.cases.filter(
      (item) =>
        item.requester.label === 'gm' &&
        item.row.facts.campaignId === table.campaignId &&
        item.row.facts.visibility.mode === 'party',
    );
    expect(gmParty.every((item) => item.synced)).toBe(true);
    // A player matches a party row only with resolver-supplied party facts.
    const player = table.requesters.find((item) => item.label === 'player');
    const partyRow = table.rows.find(
      (row) => row.facts.campaignId === table.campaignId && row.facts.visibility.mode === 'party',
    );
    if (player === undefined || partyRow === undefined) throw new Error('fixture');
    expect(evaluateSyncRule(table.rule, truthRequester(player), partyRow.facts)).toBe(false);
    expect(
      evaluateSyncRule(table.rule, truthRequester(player), {
        ...partyRow.facts,
        partyIds: [table.partyId],
      }),
    ).toBe(true);
  });
});

describe('A tombstone for an unseen record does not arrive', () => {
  test('a tombstone syncs to exactly the requesters that could read the live row', () => {
    for (const policy of CLASSES) {
      const table = syncTruthTable(registry(), policy.resourceClass);
      const key = (label: string) => label.replace(/\/(live|tombstone)$/, '');
      const live = new Map(
        table.cases
          .filter((item) => !item.row.deleted)
          .map((item) => [`${item.requester.label}|${key(item.row.label)}`, item.synced]),
      );
      for (const item of table.cases.filter((candidate) => candidate.row.deleted)) {
        expect(item.synced).toBe(
          live.get(`${item.requester.label}|${key(item.row.label)}`) ?? false,
        );
      }
    }
  });

  test('a deleted gm_only handout reaches no player replica', () => {
    const table = syncTruthTable(registry(), HANDOUT.resourceClass);
    const unseen = table.cases.filter(
      (item) =>
        item.row.deleted &&
        item.row.facts.visibility.mode === 'gm_only' &&
        ['player', 'second_player'].includes(item.requester.label),
    );
    expect(unseen.length).toBeGreaterThan(0);
    expect(unseen.some((item) => item.synced)).toBe(false);
  });
});
