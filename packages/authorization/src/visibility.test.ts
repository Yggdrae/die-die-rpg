import { describe, expect, test } from 'bun:test';
import type { AuditSqlExecutor, CampaignAuditSubmission } from '@rpg/audit';
import { type ActorRef, err, ok, type Role, type Visibility } from '@rpg/contracts';
import {
  type AdapterContractCheck,
  AuthorizationService,
  applyVisibilityChange,
  normalizeVisibility,
  type ResourceFacts,
  type ResourcePolicy,
  ResourcePolicyRegistry,
  runVisibilityAdapterContract,
  VISIBILITY_AUDIT_ACTIONS,
  type VisibilityActorResolver,
  type VisibilityAdapter,
  type VisibilityAuditRecorder,
  type VisibilityChange,
  type VisibilityChangeResult,
  VisibilityService,
  type VisibilityWrite,
  type VisibilityWriteResult,
  visibilityFromColumns,
  visibilityToColumns,
} from './index.ts';

const CAMPAIGN = '00000000-0000-4000-8000-0000000000a1';
const OTHER_CAMPAIGN = '00000000-0000-4000-8000-0000000000a2';
const GM = '00000000-0000-4000-8000-0000000000b1';
const GM_TWO = '00000000-0000-4000-8000-0000000000b2';
const CASEY = '00000000-0000-4000-8000-0000000000c1';
const ROWAN = '00000000-0000-4000-8000-0000000000d1';
const STRANGER = '00000000-0000-4000-8000-0000000000e1';
const OBSERVER = '00000000-0000-4000-8000-0000000000f1';
const RECORD = '00000000-0000-4000-8000-000000000101';
const PARTY = '00000000-0000-4000-8000-000000000201';
const MUTATION = '00000000-0000-4000-8000-000000000301';
const NOW = new Date('2026-10-25T12:00:00.000Z');

const EXECUTOR: AuditSqlExecutor = {
  execute: async () => [],
  transaction: (work) => work(EXECUTOR),
};

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

interface Row {
  campaignId: string;
  visibility: Visibility;
  version: number;
  deleted: boolean;
  authorUserId?: string;
}

/**
 * In-memory owner adapter. `defect` simulates the contract violations the kit must catch.
 * The check-and-apply runs synchronously after the await, which is the compare-and-set.
 */
class MemoryAdapter implements VisibilityAdapter {
  readonly rows = new Map<string, Row>();
  /** Records whose owner invariant refuses `everyone` (B-1). */
  readonly bounded = new Set<string>();
  writes = 0;

  constructor(
    readonly resourceClass: string,
    private readonly defect?:
      | 'no_version_check'
      | 'no_audit'
      | 'audit_after_commit'
      | 'ignore_invariant',
  ) {}

  put(resourceId: string, row: Partial<Row> & { visibility: Visibility }): void {
    this.rows.set(resourceId, { campaignId: CAMPAIGN, version: 1, deleted: false, ...row });
  }

  async loadFacts(campaignId: string, resourceId: string): Promise<ResourceFacts | undefined> {
    await tick();
    const row = this.rows.get(resourceId);
    if (row === undefined || row.campaignId !== campaignId || row.deleted) return undefined;
    return this.facts(resourceId, row);
  }

  async writeVisibility(write: VisibilityWrite): Promise<VisibilityWriteResult> {
    await tick();
    const row = this.rows.get(write.resourceId);
    if (row === undefined || row.campaignId !== write.campaignId || row.deleted) {
      return { ok: false, reason: 'not_found' };
    }
    if (this.defect !== 'no_version_check' && row.version !== write.expectedVersion) {
      return { ok: false, reason: 'version_conflict' };
    }
    if (
      this.defect !== 'ignore_invariant' &&
      this.bounded.has(write.resourceId) &&
      write.visibility.mode === 'everyone'
    ) {
      return { ok: false, reason: 'invariant_violation' };
    }
    const snapshot = { ...row };
    row.visibility = write.visibility;
    row.version += 1;
    this.writes += 1;
    if (this.defect === 'audit_after_commit') {
      await write.recordAudit(EXECUTOR).catch(() => undefined);
    } else if (this.defect !== 'no_audit') {
      try {
        await write.recordAudit(EXECUTOR);
      } catch (error) {
        this.rows.set(write.resourceId, snapshot);
        throw error;
      }
    }
    return { ok: true, facts: this.facts(write.resourceId, row) };
  }

  private facts(resourceId: string, row: Row): ResourceFacts {
    return {
      campaignId: row.campaignId,
      resourceClass: this.resourceClass,
      resourceId,
      visibility: row.visibility,
      version: row.version,
      ...(row.authorUserId === undefined ? {} : { authorUserId: row.authorUserId }),
    };
  }
}

/** Stand-in for identity's `ActorResolver`: current memberships only. */
class Members implements VisibilityActorResolver {
  private readonly roles = new Map<string, Role>();
  lookups = 0;

  constructor(entries: readonly (readonly [string, string, Role])[]) {
    for (const [campaignId, userId, role] of entries)
      this.roles.set(`${campaignId}:${userId}`, role);
  }

  remove(campaignId: string, userId: string): void {
    this.roles.delete(`${campaignId}:${userId}`);
  }

  async resolve(userId: string, campaignId: string) {
    this.lookups += 1;
    const role = this.roles.get(`${campaignId}:${userId}`);
    return role === undefined
      ? err('membership_not_found' as const)
      : ok<ActorRef>({ userId, campaignId, role });
  }
}

class AuditSpy implements VisibilityAuditRecorder {
  readonly within: { executor: AuditSqlExecutor; submission: CampaignAuditSubmission }[] = [];
  readonly afterCommit: CampaignAuditSubmission[] = [];

  async recordWithin(executor: AuditSqlExecutor, submission: CampaignAuditSubmission) {
    this.within.push({ executor, submission });
    return 'recorded' as const;
  }

  async recordCampaign(submission: CampaignAuditSubmission) {
    this.afterCommit.push(submission);
    return 'recorded' as const;
  }

  get all(): CampaignAuditSubmission[] {
    return [...this.within.map((entry) => entry.submission), ...this.afterCommit];
  }
}

function handoutPolicy(overrides: Partial<ResourcePolicy> = {}): ResourcePolicy {
  return {
    resourceClass: 'handout',
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
      source: 'handouts',
      campaignColumn: 'campaign_id',
      visibility: { modeColumn: 'visibility_mode', targetsColumn: 'visibility_targets' },
      deletedAtColumn: 'deleted_at',
    },
    ...overrides,
  };
}

function setup(
  options: {
    readonly visibility?: Visibility;
    readonly version?: number;
    readonly policy?: ResourcePolicy;
    readonly adapter?: MemoryAdapter;
    readonly partyTargeting?: 'active' | 'inactive';
  } = {},
) {
  const registry = new ResourcePolicyRegistry({
    requireVisibilityAdapters: true,
    partyTargeting: options.partyTargeting,
  });
  const adapter = options.adapter ?? new MemoryAdapter('handout');
  registry.register(options.policy ?? handoutPolicy(), adapter);
  adapter.put(RECORD, {
    visibility: options.visibility ?? { mode: 'gm_only' },
    version: options.version ?? 1,
  });
  const members = new Members([
    [CAMPAIGN, GM, 'gm'],
    [CAMPAIGN, GM_TWO, 'assistant_gm'],
    [CAMPAIGN, CASEY, 'player'],
    [CAMPAIGN, ROWAN, 'player'],
    [CAMPAIGN, OBSERVER, 'observer'],
    [OTHER_CAMPAIGN, STRANGER, 'gm'],
  ]);
  const audit = new AuditSpy();
  const logged: string[] = [];
  let ids = 0;
  const service = new VisibilityService({
    registry,
    actors: members,
    audit,
    log: { auditOutsideTransaction: (resourceClass) => logged.push(resourceClass) },
    now: () => NOW,
    newId: () => `00000000-0000-4000-8000-${(++ids).toString().padStart(12, '0')}`,
  });
  const authorization = new AuthorizationService(registry);
  const stored = () => adapter.rows.get(RECORD);
  const canRead = async (userId: string, role: Role) => {
    const facts = await adapter.loadFacts(CAMPAIGN, RECORD);
    if (facts === undefined) return false;
    return authorization.decide({ userId, campaignId: CAMPAIGN, role }, 'read', facts).allowed;
  };
  return { registry, adapter, members, audit, logged, service, stored, canRead };
}

function change(overrides: Partial<VisibilityChange> = {}): VisibilityChange {
  return {
    campaignId: CAMPAIGN,
    resourceClass: 'handout',
    resourceId: RECORD,
    operation: 'reveal',
    target: { mode: 'players', playerIds: [CASEY] },
    expectedVersion: 1,
    ...overrides,
  };
}

function rejection(result: VisibilityChangeResult): string | undefined {
  return result.status === 'rejected' ? result.reason : undefined;
}

describe('VisibilityService: Changing Visibility (_bdd.md)', () => {
  test('Reveal to named players grants exactly those players', async () => {
    const context = setup();
    const result = await context.service.change(GM, change());

    expect(result.status).toBe('changed');
    expect(context.stored()).toMatchObject({
      visibility: { mode: 'players', playerIds: [CASEY] },
      version: 2,
    });
    expect(await context.canRead(CASEY, 'player')).toBe(true);
    expect(await context.canRead(ROWAN, 'player')).toBe(false);
    expect(await context.canRead(GM, 'gm')).toBe(true);
  });

  test('Revealing is additive', async () => {
    const context = setup({ visibility: { mode: 'players', playerIds: [CASEY] }, version: 4 });
    const result = await context.service.change(
      GM,
      change({ target: { mode: 'players', playerIds: [ROWAN] }, expectedVersion: 4 }),
    );

    expect(result.status).toBe('changed');
    expect(context.stored()?.visibility).toEqual({ mode: 'players', playerIds: [CASEY, ROWAN] });
    expect(await context.canRead(CASEY, 'player')).toBe(true);
    expect(await context.canRead(ROWAN, 'player')).toBe(true);
  });

  test('Repeating a reveal changes nothing: no write, no version bump, no audit', async () => {
    const context = setup({ visibility: { mode: 'players', playerIds: [CASEY] }, version: 3 });
    const result = await context.service.change(GM, change({ expectedVersion: 3 }));

    expect(result.status).toBe('unchanged');
    expect(context.stored()).toMatchObject({
      visibility: { mode: 'players', playerIds: [CASEY] },
      version: 3,
    });
    expect(context.adapter.writes).toBe(0);
    expect(context.audit.all).toHaveLength(0);
  });

  test('Un-revealing the last recipient stores gm_only, never an empty grant', async () => {
    const context = setup({ visibility: { mode: 'players', playerIds: [CASEY] } });
    const result = await context.service.change(GM, change({ operation: 'unreveal' }));

    expect(result.status).toBe('changed');
    expect(context.stored()?.visibility).toEqual({ mode: 'gm_only' });
    expect(visibilityToColumns(context.stored()?.visibility ?? { mode: 'everyone' })).toEqual({
      mode: 'gm_only',
      targets: [],
    });
  });

  test('Un-reveal removes future access for the removed recipient only', async () => {
    const context = setup({ visibility: { mode: 'players', playerIds: [CASEY, ROWAN] } });
    await context.service.change(GM, change({ operation: 'unreveal' }));

    expect(context.stored()?.visibility).toEqual({ mode: 'players', playerIds: [ROWAN] });
    expect(await context.canRead(CASEY, 'player')).toBe(false);
    expect(await context.canRead(ROWAN, 'player')).toBe(true);
  });

  test('Every visibility change is audited once, inside the adapter transaction', async () => {
    const context = setup();
    const revealed = await context.service.change(GM, change({ mutationId: MUTATION }));
    const unrevealed = await context.service.change(
      GM,
      change({ operation: 'unreveal', expectedVersion: 2 }),
    );

    expect(revealed).toMatchObject({ status: 'changed', audit: 'within_transaction' });
    expect(unrevealed).toMatchObject({ status: 'changed', audit: 'within_transaction' });
    expect(context.audit.afterCommit).toHaveLength(0);
    expect(context.audit.within.map((entry) => entry.executor)).toEqual([EXECUTOR, EXECUTOR]);
    const [reveal, unreveal] = context.audit.within.map((entry) => entry.submission);
    expect(reveal).toEqual({
      event: {
        campaignId: CAMPAIGN,
        actor: { userId: GM, campaignId: CAMPAIGN, role: 'gm' },
        action: VISIBILITY_AUDIT_ACTIONS.reveal,
        targetType: 'handout',
        targetId: RECORD,
        before: { visibility: { mode: 'gm_only' }, version: 1 },
        after: { visibility: { mode: 'players', playerIds: [CASEY] }, version: 2 },
        at: NOW.toISOString(),
        private: false,
      },
      originMutationId: MUTATION,
      targetVisibility: { visibility: { mode: 'gm_only' } },
    });
    expect(unreveal?.event).toMatchObject({
      action: 'visibility.unrevealed',
      before: { visibility: { mode: 'players', playerIds: [CASEY] }, version: 2 },
      after: { visibility: { mode: 'gm_only' }, version: 3 },
    });
    expect(unreveal?.originMutationId).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('An unauthorized visibility change leaves the record untouched', async () => {
    for (const actor of [CASEY, OBSERVER]) {
      const context = setup({ visibility: { mode: 'players', playerIds: [CASEY] } });
      const result = await context.service.change(
        actor,
        change({ target: { mode: 'players', playerIds: [ROWAN] } }),
      );

      expect(rejection(result)).toBe('denied');
      expect(context.stored()).toMatchObject({
        visibility: { mode: 'players', playerIds: [CASEY] },
        version: 1,
      });
      expect(context.adapter.writes).toBe(0);
      expect(context.audit.all).toHaveLength(0);
    }
  });

  test('An unauthorized actor learns nothing about target membership', async () => {
    const context = setup();
    const lookupsBefore = context.members.lookups;
    const result = await context.service.change(
      CASEY,
      change({ target: { mode: 'players', playerIds: [STRANGER] } }),
    );

    expect(rejection(result)).toBe('denied');
    expect(context.members.lookups - lookupsBefore).toBe(1);
  });

  test('A grant cannot name a non-member, a removed member, or a member of another campaign', async () => {
    const context = setup();
    context.members.remove(CAMPAIGN, ROWAN);
    for (const target of [STRANGER, ROWAN]) {
      const result = await context.service.change(
        GM,
        change({ target: { mode: 'players', playerIds: [CASEY, target] } }),
      );
      expect(rejection(result)).toBe('target_not_member');
    }
    expect(context.stored()).toMatchObject({ visibility: { mode: 'gm_only' }, version: 1 });
    expect(context.adapter.writes).toBe(0);
    expect(context.audit.all).toHaveLength(0);
  });

  test('A repeated reveal naming a since-removed member is rejected, not silently kept', async () => {
    const context = setup({ visibility: { mode: 'players', playerIds: [CASEY] } });
    context.members.remove(CAMPAIGN, CASEY);
    const result = await context.service.change(GM, change());
    expect(rejection(result)).toBe('target_not_member');
  });

  test('Un-reveal may subtract a removed member stale ID', async () => {
    const context = setup({ visibility: { mode: 'players', playerIds: [CASEY, ROWAN] } });
    context.members.remove(CAMPAIGN, CASEY);
    const result = await context.service.change(GM, change({ operation: 'unreveal' }));
    expect(result.status).toBe('changed');
    expect(context.stored()?.visibility).toEqual({ mode: 'players', playerIds: [ROWAN] });
  });

  test('Concurrent visibility changes do not silently drop a grant', async () => {
    const context = setup({ version: 4 });
    const [first, second] = await Promise.all([
      context.service.change(GM, change({ expectedVersion: 4 })),
      context.service.change(
        GM_TWO,
        change({ target: { mode: 'players', playerIds: [ROWAN] }, expectedVersion: 4 }),
      ),
    ]);
    const statuses = [first?.status, second?.status].sort();

    expect(statuses).toEqual(['changed', 'conflict']);
    const winner = first?.status === 'changed' ? CASEY : ROWAN;
    expect(context.stored()).toMatchObject({
      visibility: { mode: 'players', playerIds: [winner] },
      version: 5,
    });
    // The loser is not merged or retried; it must be resubmitted against version 5.
    expect(context.audit.all).toHaveLength(1);
    expect(context.adapter.writes).toBe(1);
  });

  test('A stale expected version is a conflict and writes nothing', async () => {
    const context = setup({ version: 5 });
    const result = await context.service.change(GM, change({ expectedVersion: 4 }));
    expect(result).toEqual({ status: 'conflict' });
    expect(context.adapter.writes).toBe(0);
    expect(context.audit.all).toHaveLength(0);
  });

  test('Reveal input is normalized to sorted unique IDs', async () => {
    const context = setup();
    await context.service.change(
      GM,
      change({ target: { mode: 'players', playerIds: [ROWAN, CASEY, ROWAN] } }),
    );
    expect(context.stored()?.visibility).toEqual({ mode: 'players', playerIds: [CASEY, ROWAN] });
  });

  test('Reveal to everyone, then un-reveal from everyone back to gm_only', async () => {
    const context = setup({ visibility: { mode: 'players', playerIds: [CASEY] } });
    await context.service.change(GM, change({ target: { mode: 'everyone' } }));
    expect(context.stored()?.visibility).toEqual({ mode: 'everyone' });
    await context.service.change(
      GM,
      change({ operation: 'unreveal', target: { mode: 'everyone' }, expectedVersion: 2 }),
    );
    expect(context.stored()).toMatchObject({ visibility: { mode: 'gm_only' }, version: 3 });
  });
});

describe('VisibilityService: fail-closed inputs', () => {
  test('actor not a current member, or a member of another campaign only', async () => {
    const context = setup();
    expect(rejection(await context.service.change(STRANGER, change()))).toBe('actor_not_member');
    expect(
      rejection(await context.service.change(ROWAN, change({ campaignId: OTHER_CAMPAIGN }))),
    ).toBe('actor_not_member');
  });

  test('unknown class, class without adapter, and missing record', async () => {
    const context = setup();
    context.registry.register({
      ...handoutPolicy({ resourceClass: 'server_note', capabilities: ['read'] }),
      roleCapabilities: {
        owner: ['read'],
        gm: ['read'],
        assistant_gm: ['read'],
        player: ['read'],
        observer: [],
      },
    });
    expect(rejection(await context.service.change(GM, change({ resourceClass: 'nope' })))).toBe(
      'unknown_resource_class',
    );
    expect(
      rejection(await context.service.change(GM, change({ resourceClass: 'server_note' }))),
    ).toBe('unknown_resource_class');
    expect(rejection(await context.service.change(GM, change({ resourceId: PARTY })))).toBe(
      'not_found',
    );
  });

  test('a record in another campaign is not found through this campaign', async () => {
    const context = setup();
    context.adapter.put(PARTY, { campaignId: OTHER_CAMPAIGN, visibility: { mode: 'gm_only' } });
    expect(rejection(await context.service.change(GM, change({ resourceId: PARTY })))).toBe(
      'not_found',
    );
  });

  test.each([
    ['actor id', { actor: 'not-a-uuid' }],
    ['version 0', { change: { expectedVersion: 0 } }],
    ['fractional version', { change: { expectedVersion: 1.5 } }],
    ['empty targets', { change: { target: { mode: 'players', playerIds: [] } } }],
    ['uppercase id', { change: { target: { mode: 'players', playerIds: [CASEY.toUpperCase()] } } }],
    ['unknown operation', { change: { operation: 'replace' } }],
    ['unknown target mode', { change: { target: { mode: 'gm_only' } } }],
    ['bad mutation id', { change: { mutationId: 'abc' } }],
    [
      'too many targets',
      {
        change: {
          target: {
            mode: 'players',
            playerIds: Array.from({ length: 101 }, () => crypto.randomUUID()),
          },
        },
      },
    ],
  ])('invalid change: %s', async (_label, input) => {
    const context = setup();
    const { actor = GM, change: overrides = {} } = input as {
      actor?: string;
      change?: Record<string, unknown>;
    };
    const result = await context.service.change(actor, {
      ...change(),
      ...overrides,
    } as VisibilityChange);
    expect(rejection(result)).toBe('invalid_change');
    expect(context.adapter.writes).toBe(0);
  });

  test('party targets fail closed: not declared, or declared but no party resolver (P0)', async () => {
    const target = { mode: 'party', partyIds: [PARTY] } as const;
    const undeclared = setup();
    expect(rejection(await undeclared.service.change(GM, change({ target })))).toBe(
      'target_mode_not_allowed',
    );
    const declared = setup({
      partyTargeting: 'active',
      policy: handoutPolicy({ revealTargets: ['players', 'party'] }),
    });
    expect(rejection(await declared.service.change(GM, change({ target })))).toBe(
      'party_unresolved',
    );
    expect(declared.adapter.writes).toBe(0);
  });

  test('players target not declared by the class is rejected', async () => {
    const context = setup({
      partyTargeting: 'active',
      policy: handoutPolicy({ revealTargets: ['party'] }),
    });
    expect(rejection(await context.service.change(GM, change()))).toBe('target_mode_not_allowed');
  });

  test('subtracting named players from everyone is rejected, not guessed', async () => {
    const context = setup({ visibility: { mode: 'everyone' } });
    expect(rejection(await context.service.change(GM, change({ operation: 'unreveal' })))).toBe(
      'incompatible_visibility',
    );
    expect(context.stored()?.visibility).toEqual({ mode: 'everyone' });
  });

  test('B-1: an owner invariant refusal is incompatible_visibility, unchanged, unaudited', async () => {
    const context = setup();
    context.adapter.bounded.add(RECORD);
    const result = await context.service.change(GM, change({ target: { mode: 'everyone' } }));
    expect(rejection(result)).toBe('incompatible_visibility');
    expect(context.stored()).toMatchObject({ visibility: { mode: 'gm_only' }, version: 1 });
    expect(context.audit.within).toHaveLength(0);
    expect(context.audit.afterCommit).toHaveLength(0);
    // A value within the invariant is still accepted.
    expect((await context.service.change(GM, change())).status).toBe('changed');
  });

  test('an adapter that skips recordAudit still yields exactly one (post-commit) audit', async () => {
    const context = setup({ adapter: new MemoryAdapter('handout', 'no_audit') });
    const result = await context.service.change(GM, change());
    expect(result).toMatchObject({ status: 'changed', audit: 'after_commit' });
    expect(context.audit.within).toHaveLength(0);
    expect(context.audit.afterCommit).toHaveLength(1);
    expect(context.logged).toEqual(['handout']);
  });

  test('an Ownership Rule on reveal is honoured and the audit follows the author', async () => {
    const policy = handoutPolicy({
      ownership: { field: 'authorUserId', capabilities: ['reveal'], exemptRoles: [] },
    });
    const context = setup({ policy });
    context.adapter.put(RECORD, { visibility: { mode: 'gm_only' }, authorUserId: GM_TWO });
    expect(rejection(await context.service.change(GM, change()))).toBe('denied');
    expect((await context.service.change(GM_TWO, change())).status).toBe('changed');
    expect(context.audit.all[0]?.targetVisibility).toEqual({
      visibility: { mode: 'gm_only' },
      authorUserId: GM_TWO,
    });
  });
});

describe('Visibility normalization (pure)', () => {
  const players = (...playerIds: string[]): Visibility => ({ mode: 'players', playerIds });

  test.each([
    ['reveal into gm_only', { mode: 'gm_only' }, 'reveal', [ROWAN, CASEY], players(CASEY, ROWAN)],
    ['union', players(ROWAN), 'reveal', [CASEY], players(CASEY, ROWAN)],
    ['idempotent', players(CASEY), 'reveal', [CASEY], players(CASEY)],
    ['everyone already admits', { mode: 'everyone' }, 'reveal', [CASEY], { mode: 'everyone' }],
    ['subtract', players(CASEY, ROWAN), 'unreveal', [CASEY], players(ROWAN)],
    ['subtract last', players(CASEY), 'unreveal', [CASEY], { mode: 'gm_only' }],
    ['subtract absent', players(ROWAN), 'unreveal', [CASEY], players(ROWAN)],
    ['subtract from gm_only', { mode: 'gm_only' }, 'unreveal', [CASEY], { mode: 'gm_only' }],
  ] as const)('%s', (_label, current, operation, playerIds, expected) => {
    const result = applyVisibilityChange(current as Visibility, operation, {
      mode: 'players',
      playerIds,
    });
    expect(result).toEqual({ ok: true, visibility: expected as Visibility });
  });

  test('mixing targeted modes is incompatible', () => {
    expect(
      applyVisibilityChange({ mode: 'party', partyIds: [PARTY] }, 'reveal', {
        mode: 'players',
        playerIds: [CASEY],
      }),
    ).toEqual({ ok: false, reason: 'incompatible_visibility' });
  });

  test('normalizeVisibility sorts, dedupes, and maps an empty targeted set to gm_only', () => {
    expect(normalizeVisibility(players(ROWAN, CASEY, ROWAN))).toEqual(players(CASEY, ROWAN));
    expect(normalizeVisibility({ mode: 'party', partyIds: [] })).toEqual({ mode: 'gm_only' });
  });

  test('visibilityFromColumns accepts only the canonical representation', () => {
    expect(visibilityFromColumns('players', [CASEY, ROWAN])).toEqual(players(CASEY, ROWAN));
    expect(visibilityFromColumns('everyone', [])).toEqual({ mode: 'everyone' });
    for (const [mode, targets] of [
      ['players', []],
      ['players', [ROWAN, CASEY]],
      ['players', [CASEY, CASEY]],
      ['players', ['x']],
      ['gm_only', [CASEY]],
      ['secret', []],
      ['players', 'nope'],
    ] as const) {
      expect(visibilityFromColumns(mode, targets)).toBeUndefined();
    }
  });
});

describe('runVisibilityAdapterContract', () => {
  const subject = (adapter: MemoryAdapter) => ({
    adapter,
    seed: async (input: { campaignId: string; visibility: Visibility }) => {
      const resourceId = crypto.randomUUID();
      adapter.put(resourceId, input);
      return resourceId;
    },
    tombstone: async (_campaignId: string, resourceId: string) => {
      const row = adapter.rows.get(resourceId);
      if (row !== undefined) row.deleted = true;
    },
  });

  test('a conforming adapter has no findings', async () => {
    const report = await runVisibilityAdapterContract(subject(new MemoryAdapter('handout')));
    expect(report.findings).toEqual([]);
    expect(report.checks).toHaveLength(10);
  });

  const bounded = (adapter: MemoryAdapter) => ({
    ...subject(adapter),
    invariantViolation: async (campaignId: string) => {
      const resourceId = crypto.randomUUID();
      adapter.put(resourceId, { campaignId, visibility: { mode: 'gm_only' } });
      adapter.bounded.add(resourceId);
      return { resourceId, visibility: { mode: 'everyone' } as Visibility };
    },
  });

  test('B-1: the optional invariant check passes for a refusing adapter', async () => {
    const report = await runVisibilityAdapterContract(bounded(new MemoryAdapter('handout')));
    expect(report.checks).toHaveLength(11);
    expect(report.checks).toContain('invariant_refused');
    expect(report.findings).toEqual([]);
  });

  test('B-1: an adapter that writes an invariant-violating value is reported', async () => {
    const report = await runVisibilityAdapterContract(
      bounded(new MemoryAdapter('handout', 'ignore_invariant')),
    );
    expect(report.findings.map((finding) => finding.check)).toEqual([
      'invariant_refused',
      'invariant_refused',
      'invariant_refused',
    ]);
  });

  test.each([
    ['no_version_check', ['write_stale_version', 'concurrent_single_winner']],
    ['no_audit', ['write_applies', 'audit_in_transaction', 'concurrent_single_winner']],
    ['audit_after_commit', ['audit_in_transaction']],
  ] as const)('detects defect %s', async (defect, expected) => {
    const report = await runVisibilityAdapterContract(
      subject(new MemoryAdapter('handout', defect)),
    );
    const failed = new Set<AdapterContractCheck>(report.findings.map((finding) => finding.check));
    expect([...failed].sort()).toEqual([...expected].sort());
  });
});
