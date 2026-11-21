import { describe, expect, test } from 'bun:test';
import {
  AUTHOR_PRIVATE_NOTE_FIXTURE,
  findSyncDivergences,
  type ResourcePolicy,
  ResourcePolicyRegistry,
  SyncPredicateCompiler,
  type SyncTruthTable,
  syncTruthTable,
  visibilityToColumns,
} from '@rpg/authorization';
import { type MembershipRelation, renderSyncRuleQuery } from '../../sync-rules.ts';

/**
 * Feature 04 task 05 / feature 03 task 07: the PowerSync dialect of the compiled sync predicates,
 * evaluated by the PowerSync Service 1.25.0 sync-rules engine itself (`infra/powersync/
 * engine-check.mjs`, run inside the service container), agrees with the pure decision on the
 * exhaustive truth table: every role including observer, removed members, non-members, other
 * campaigns, every Visibility mode and target set, every author, live rows and tombstones. This
 * covers `auth.user_id() IN <json column>`, JSON-array value sets, and `OR` branches that mix
 * membership and row conditions, which no table replicated today exercises end to end.
 *
 * Opt-in: set `POWERSYNC_ENGINE_EXEC` to the command prefix that runs a process in the service
 * container, for example `docker exec -i rpg-powersync` (or `wsl -e docker exec -i rpg-powersync`
 * on Windows with Docker in WSL). Skipped otherwise.
 */

const EXEC = process.env.POWERSYNC_ENGINE_EXEC?.trim().split(/\s+/) ?? [];
const SYNC_CONFIG = new URL('../../../../../infra/powersync/sync-config.yaml', import.meta.url);

interface EngineResult {
  readonly diagnostics: { readonly type: string; readonly message: string }[];
  readonly errors?: string[];
  readonly delivered?: Record<string, string[]>;
}

async function engine(input: Record<string, unknown>): Promise<EngineResult> {
  const child = Bun.spawn([...EXEC, 'node', '/config/engine-check.mjs'], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  child.stdin.write(JSON.stringify(input));
  await child.stdin.end();
  const [out, err] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if ((await child.exited) !== 0) throw new Error(`engine-check failed: ${err.slice(0, 2000)}`);
  return JSON.parse(out.trim().split('\n').at(-1) ?? '') as EngineResult;
}

const MEMBERS: MembershipRelation = {
  source: 'probe_members',
  userColumn: 'user_id',
  campaignColumn: 'campaign_id',
  roleColumn: 'role',
  removedAtColumn: 'removed_at',
};
const visibility = { modeColumn: 'visibility_mode', targetsColumn: 'visibility_targets' } as const;
const everyReader = {
  owner: ['read'],
  gm: ['read'],
  assistant_gm: ['read'],
  player: ['read'],
  observer: [],
} satisfies ResourcePolicy['roleCapabilities'];

function targeted(
  name: string,
  roles: ResourcePolicy['roleCapabilities'],
  extra: Partial<ResourcePolicy> = {},
): ResourcePolicy {
  return {
    resourceClass: `fixture.${name}`,
    capabilities: ['read'],
    roleCapabilities: roles,
    defaultVisibility: { mode: 'gm_only' },
    sync: {
      kind: 'replicated',
      source: `probe_${name}`,
      campaignColumn: 'campaign_id',
      visibility,
      deletedAtColumn: 'deleted_at',
      ...(extra.ownership === undefined
        ? {}
        : { ownershipColumns: { authorUserId: 'author_user_id' } }),
    },
    ...extra,
  };
}

const POLICIES: ResourcePolicy[] = [
  targeted('handout', everyReader),
  targeted('owned_prep', everyReader, {
    ownership: { field: 'authorUserId', capabilities: ['read'], exemptRoles: ['owner', 'gm'] },
    defaultVisibility: 'explicit',
  }),
  targeted('gm_secret', {
    owner: ['read'],
    gm: ['read'],
    assistant_gm: [],
    player: [],
    observer: [],
  }),
  {
    ...targeted('campaign_wide', everyReader),
    defaultVisibility: { mode: 'everyone' },
    sync: {
      kind: 'replicated',
      source: 'probe_campaign_wide',
      campaignColumn: 'campaign_id',
      visibility: 'campaign_wide',
      deletedAtColumn: 'deleted_at',
    },
  },
  {
    ...AUTHOR_PRIVATE_NOTE_FIXTURE,
    sync: {
      ...(AUTHOR_PRIVATE_NOTE_FIXTURE.sync as Extract<
        ResourcePolicy['sync'],
        { kind: 'replicated' }
      >),
      source: 'probe_author_private',
    },
  },
];

const registry = new ResourcePolicyRegistry();
for (const policy of POLICIES) registry.register(policy);
const compiler = new SyncPredicateCompiler(registry);
const COLUMNS = [
  'id',
  'campaign_id',
  'visibility_mode',
  'visibility_targets',
  'author_user_id',
  'deleted_at',
  'version',
];

function queryFor(policy: ResourcePolicy): string {
  const wide = policy.sync.kind === 'replicated' && policy.sync.visibility === 'campaign_wide';
  return renderSyncRuleQuery(
    compiler.compile(policy.resourceClass).rule,
    {
      resourceClass: policy.resourceClass,
      stream: 'probe',
      columns: wide ? ['id', 'campaign_id', 'deleted_at', 'version'] : COLUMNS,
    },
    MEMBERS,
  );
}

/** Which rows of `table` the engine delivers to each requester when `query` is the stream. */
async function delivered(
  policy: ResourcePolicy,
  table: SyncTruthTable,
  query: string,
): Promise<Map<string, Set<string>>> {
  if (policy.sync.kind !== 'replicated') throw new Error('not replicated');
  const result = await engine({
    yaml: `config:\n  edition: 3\nstreams:\n  probe:\n    auto_subscribe: true\n    query: ${JSON.stringify(query)}\n`,
    memberTable: MEMBERS.source,
    rowTable: policy.sync.source,
    members: table.requesters.flatMap((requester) =>
      requester.memberships.map((membership) => ({
        campaign_id: membership.campaignId,
        user_id: requester.userId,
        role: membership.role,
        removed_at: membership.removed ? '2026-09-01T00:00:00Z' : null,
      })),
    ),
    // As PowerSync replicates them: jsonb arrives as JSON text, timestamps as text.
    rows: table.rows.map((row) => {
      const { mode, targets } = visibilityToColumns(row.facts.visibility);
      return {
        id: row.id,
        campaign_id: row.facts.campaignId,
        visibility_mode: mode,
        visibility_targets: JSON.stringify(targets),
        author_user_id: row.facts.authorUserId ?? null,
        deleted_at: row.deleted ? '2026-10-01T00:00:00Z' : null,
        version: 1,
      };
    }),
    users: table.requesters.map((requester) => requester.userId),
  });
  expect(result.diagnostics.filter((item) => item.type === 'fatal')).toEqual([]);
  expect(result.errors).toEqual([]);
  return new Map(Object.entries(result.delivered ?? {}).map(([user, ids]) => [user, new Set(ids)]));
}

describe.skipIf(EXEC.length === 0)('PowerSync 1.25.0 sync-rules engine', () => {
  test('infra/powersync/sync-config.yaml compiles with no errors or warnings', async () => {
    const result = await engine({ yaml: await Bun.file(SYNC_CONFIG).text() });
    expect(result.diagnostics).toEqual([]);
  });

  for (const policy of POLICIES) {
    test(`${policy.resourceClass}: the engine delivers exactly what decide allows`, async () => {
      const table = syncTruthTable(registry, policy.resourceClass, {
        newId: () => crypto.randomUUID(),
      });
      const sets = await delivered(policy, table, queryFor(policy));
      const observed = (requester: { userId: string }, row: { id: string }) =>
        sets.get(requester.userId)?.has(row.id) ?? false;
      expect(findSyncDivergences(table, observed)).toEqual([]);
      expect(table.cases.some((item) => item.api)).toBe(true);
    }, 60_000);
  }

  test('the check is sensitive: a query without the target filter leaks rows', async () => {
    const policy = POLICIES[0] as ResourcePolicy;
    const table = syncTruthTable(registry, policy.resourceClass, {
      newId: () => crypto.randomUUID(),
    });
    const query = queryFor(policy);
    const leaky = query.replace(/ AND auth\.user_id\(\) IN [a-z_]+\.visibility_targets/, '');
    expect(leaky).not.toBe(query);
    const sets = await delivered(policy, table, leaky);
    const observed = (requester: { userId: string }, row: { id: string }) =>
      sets.get(requester.userId)?.has(row.id) ?? false;
    expect(findSyncDivergences(table, observed).length).toBeGreaterThan(0);
  }, 60_000);
});
