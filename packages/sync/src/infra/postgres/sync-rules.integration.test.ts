import { afterAll, describe, expect, test } from 'bun:test';
import {
  AUTHOR_PRIVATE_NOTE_FIXTURE,
  findSyncDivergences,
  type ResourcePolicy,
  ResourcePolicyRegistry,
  SyncPredicateCompiler,
  type SyncTruthRow,
  syncTruthTable,
  visibilityToColumns,
} from '@rpg/authorization';
import type { Visibility } from '@rpg/contracts';
import postgres from 'postgres';
import {
  type MembershipRelation,
  POSTGRES_DIALECT,
  renderSyncRuleQuery,
  type SyncRuleBinding,
} from '../../sync-rules.ts';

/**
 * Feature 04 task 05 / feature 03 task 07: the compiled sync predicate evaluated as real SQL on
 * PostgreSQL agrees with the pure decision on the exhaustive truth table, and a simulated
 * replica receives reveals, loses un-revealed rows, and never sees an unseen row, count, or
 * tombstone. Test-scoped tables only (dropped afterwards). The SQL is the PostgreSQL dialect of
 * the same renderer that produces the PowerSync stream queries; the PowerSync service itself is
 * not exercised here. Skipped when no database is reachable.
 */

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const candidate =
  databaseUrl === undefined ? undefined : postgres(databaseUrl, { max: 2, onnotice: () => {} });
const sql = await (async () => {
  if (candidate === undefined) return undefined;
  try {
    await candidate`select 1`;
    return candidate;
  } catch {
    await candidate.end();
    return undefined;
  }
})();

const PREFIX = `sync_rule_probe_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
const created: string[] = [];

const visibilityColumns = {
  modeColumn: 'visibility_mode',
  targetsColumn: 'visibility_targets',
} as const;
const READ_ALL = ['read'] as const;

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
      source: `${PREFIX}_${name}`,
      campaignColumn: 'campaign_id',
      visibility: visibilityColumns,
      deletedAtColumn: 'deleted_at',
      ...(extra.ownership === undefined
        ? {}
        : { ownershipColumns: { authorUserId: 'author_user_id' } }),
    },
    ...extra,
  };
}

const everyReader = {
  owner: [...READ_ALL],
  gm: [...READ_ALL],
  assistant_gm: [...READ_ALL],
  player: [...READ_ALL],
  observer: [],
};

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
      source: `${PREFIX}_campaign_wide`,
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
      source: `${PREFIX}_author_private`,
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
  'body',
];

function bindingFor(policy: ResourcePolicy): SyncRuleBinding {
  const wide = policy.sync.kind === 'replicated' && policy.sync.visibility === 'campaign_wide';
  return {
    resourceClass: policy.resourceClass,
    stream: 'probe',
    columns: wide ? ['id', 'campaign_id', 'deleted_at', 'version', 'body'] : COLUMNS,
  };
}

function membersFor(table: string): MembershipRelation {
  return {
    source: table,
    userColumn: 'user_id',
    campaignColumn: 'campaign_id',
    roleColumn: 'role',
    removedAtColumn: 'removed_at',
  };
}

async function createTables(policy: ResourcePolicy): Promise<{ rows: string; members: string }> {
  if (sql === undefined || policy.sync.kind !== 'replicated') throw new Error('unavailable');
  const rows = policy.sync.source;
  const members = `${rows}_members`;
  created.push(rows, members);
  // No role CHECK on the probe membership table, so the observer row is representable.
  await sql.unsafe(`create table ${members} (
    campaign_id uuid not null, user_id uuid not null, role text not null,
    removed_at timestamptz, primary key (campaign_id, user_id))`);
  await sql.unsafe(`create table ${rows} (
    id uuid primary key, campaign_id uuid not null,
    visibility_mode text not null default 'everyone',
    visibility_targets jsonb not null default '[]'::jsonb,
    author_user_id uuid, deleted_at timestamptz, version bigint not null default 1,
    body text not null default '')`);
  return { rows, members };
}

async function insertJson(table: string, records: readonly Record<string, unknown>[]) {
  if (sql === undefined || records.length === 0) return;
  await sql.unsafe(
    `insert into ${table} select * from jsonb_populate_recordset(null::${table}, $1::text::jsonb)`,
    [JSON.stringify(records)],
  );
}

function rowRecord(row: SyncTruthRow): Record<string, unknown> {
  const { mode, targets } = visibilityToColumns(row.facts.visibility);
  return {
    id: row.id,
    campaign_id: row.facts.campaignId,
    visibility_mode: mode,
    visibility_targets: targets,
    author_user_id: row.facts.authorUserId ?? null,
    deleted_at: row.deleted ? '2026-10-01T00:00:00Z' : null,
    version: 1,
    body: `body-${row.id}`,
  };
}

afterAll(async () => {
  if (sql === undefined) return;
  for (const table of created.reverse()) {
    try {
      await sql.unsafe(`drop table if exists ${table}`);
    } catch {
      // Best effort; the names are unique per run.
    }
  }
  await sql.end({ timeout: 1 });
});

describe.skipIf(sql === undefined)('API-vs-sync truth table as PostgreSQL SQL', () => {
  for (const policy of POLICIES) {
    test(`${policy.resourceClass}: SQL, in-process AST, and decide agree on every case`, async () => {
      if (sql === undefined) throw new Error('database unavailable');
      const { rows, members } = await createTables(policy);
      const table = syncTruthTable(registry, policy.resourceClass);
      await insertJson(
        members,
        table.requesters.flatMap((requester) =>
          requester.memberships.map((membership) => ({
            campaign_id: membership.campaignId,
            user_id: requester.userId,
            role: membership.role,
            removed_at: membership.removed ? '2026-09-01T00:00:00Z' : null,
          })),
        ),
      );
      await insertJson(rows, table.rows.map(rowRecord));
      const query = renderSyncRuleQuery(
        compiler.compile(policy.resourceClass).rule,
        bindingFor(policy),
        membersFor(members),
        POSTGRES_DIALECT,
      );
      const synced = new Map<string, Set<string>>();
      for (const requester of table.requesters) {
        const result = await sql.unsafe<{ id: string }[]>(query, [requester.userId]);
        synced.set(requester.userId, new Set(result.map((row) => row.id)));
      }
      const observed = (requester: { userId: string }, row: SyncTruthRow) =>
        synced.get(requester.userId)?.has(row.id) ?? false;
      expect(findSyncDivergences(table, observed)).toEqual([]);
      expect(findSyncDivergences(table)).toEqual([]);
      expect(table.cases.length).toBe(table.requesters.length * table.rows.length);
      expect(table.cases.some((item) => item.api)).toBe(true);
    });
  }
});

/** A replica as the provider would maintain it: put changed rows, remove rows that left. */
class SimulatedReplica {
  readonly rows = new Map<string, string>();
  readonly payloads: string[] = [];

  apply(result: readonly Record<string, unknown>[]): { put: string[]; remove: string[] } {
    const next = new Map(result.map((row) => [String(row.id), JSON.stringify(row)]));
    const put = [...next].filter(([id, value]) => this.rows.get(id) !== value).map(([id]) => id);
    const remove = [...this.rows.keys()].filter((id) => !next.has(id));
    this.payloads.push(JSON.stringify(put.map((id) => next.get(id))));
    this.rows.clear();
    for (const [id, value] of next) this.rows.set(id, value);
    return { put, remove };
  }
}

describe.skipIf(sql === undefined)(
  'replica delivery on PostgreSQL (simulated provider diff)',
  () => {
    const campaignId = crypto.randomUUID();
    const gm = crypto.randomUUID();
    const casey = crypto.randomUUID();
    const rowan = crypto.randomUUID();
    let tables: { rows: string; members: string } | undefined;
    let notes: { rows: string; members: string } | undefined;

    async function setup() {
      if (sql === undefined) throw new Error('database unavailable');
      if (tables !== undefined && notes !== undefined) return { tables, notes };
      const handoutPolicy = { ...(POLICIES[0] as ResourcePolicy) };
      const notePolicy = POLICIES[4] as ResourcePolicy;
      tables = await createTables({
        ...handoutPolicy,
        sync: {
          ...(handoutPolicy.sync as Extract<ResourcePolicy['sync'], { kind: 'replicated' }>),
          source: `${PREFIX}_handout_flow`,
        },
      });
      notes = await createTables({
        ...notePolicy,
        sync: {
          ...(notePolicy.sync as Extract<ResourcePolicy['sync'], { kind: 'replicated' }>),
          source: `${PREFIX}_note_flow`,
        },
      });
      for (const members of [tables.members, notes.members]) {
        await insertJson(members, [
          { campaign_id: campaignId, user_id: gm, role: 'gm', removed_at: null },
          { campaign_id: campaignId, user_id: casey, role: 'player', removed_at: null },
          { campaign_id: campaignId, user_id: rowan, role: 'player', removed_at: null },
        ]);
      }
      return { tables, notes };
    }

    /** The handout query reads `${PREFIX}_handout`; point it at the flow table instead. */
    function query(policy: ResourcePolicy, rows: string, members: string): string {
      const rule = compiler.compile(policy.resourceClass).rule;
      const source = rule.source;
      if (source === undefined) throw new Error('fixture');
      return renderSyncRuleQuery(
        { ...rule, source: { ...source, source: rows } },
        bindingFor(policy),
        membersFor(members),
        POSTGRES_DIALECT,
      );
    }

    async function pull(text: string, userId: string) {
      if (sql === undefined) throw new Error('database unavailable');
      return sql.unsafe<Record<string, unknown>[]>(text, [userId]);
    }

    async function setVisibility(table: string, id: string, visibility: Visibility) {
      if (sql === undefined) throw new Error('database unavailable');
      const { mode, targets } = visibilityToColumns(visibility);
      await sql.unsafe(
        `update ${table} set visibility_mode = $2, visibility_targets = $3::text::jsonb, version = version + 1 where id = $1`,
        [id, mode, JSON.stringify(targets)],
      );
    }

    test('Reveal to one player delivers to that player only; un-reveal removes it', async () => {
      const { tables: flow } = await setup();
      const text = query(POLICIES[0] as ResourcePolicy, flow.rows, flow.members);
      const handout = crypto.randomUUID();
      await insertJson(flow.rows, [
        {
          id: handout,
          campaign_id: campaignId,
          visibility_mode: 'gm_only',
          visibility_targets: [],
          author_user_id: null,
          deleted_at: null,
          version: 1,
          body: 'Secret map of the barrow',
        },
      ]);
      const caseyReplica = new SimulatedReplica();
      const rowanReplica = new SimulatedReplica();
      const gmReplica = new SimulatedReplica();

      // A GM-only record is absent from a player device.
      expect(caseyReplica.apply(await pull(text, casey))).toEqual({ put: [], remove: [] });
      expect(rowanReplica.apply(await pull(text, rowan))).toEqual({ put: [], remove: [] });
      expect(gmReplica.apply(await pull(text, gm)).put).toEqual([handout]);

      await setVisibility(flow.rows, handout, { mode: 'players', playerIds: [casey] });
      expect(caseyReplica.apply(await pull(text, casey))).toEqual({ put: [handout], remove: [] });
      expect(rowanReplica.apply(await pull(text, rowan))).toEqual({ put: [], remove: [] });
      expect(caseyReplica.rows.get(handout)).toContain('Secret map of the barrow');
      expect(rowanReplica.rows.has(handout)).toBe(false);

      // Un-reveal: removed from Casey's local database on the next synchronization.
      await setVisibility(flow.rows, handout, { mode: 'gm_only' });
      expect(caseyReplica.apply(await pull(text, casey))).toEqual({ put: [], remove: [handout] });
      expect(caseyReplica.rows.has(handout)).toBe(false);
      expect(rowanReplica.apply(await pull(text, rowan))).toEqual({ put: [], remove: [] });

      // No network payload to Rowan's device ever carried the handout.
      for (const payload of rowanReplica.payloads) {
        expect(payload).not.toContain(handout);
        expect(payload).not.toContain('Secret map');
      }
    });

    test('A tombstone for an unseen record does not arrive; a seen one does', async () => {
      if (sql === undefined) throw new Error('database unavailable');
      const { tables: flow } = await setup();
      const text = query(POLICIES[0] as ResourcePolicy, flow.rows, flow.members);
      const unseen = crypto.randomUUID();
      const seen = crypto.randomUUID();
      await insertJson(flow.rows, [
        {
          id: unseen,
          campaign_id: campaignId,
          visibility_mode: 'gm_only',
          visibility_targets: [],
          author_user_id: null,
          deleted_at: null,
          version: 1,
          body: 'never revealed',
        },
        {
          id: seen,
          campaign_id: campaignId,
          visibility_mode: 'players',
          visibility_targets: [casey],
          author_user_id: null,
          deleted_at: null,
          version: 1,
          body: 'revealed to Casey',
        },
      ]);
      const caseyReplica = new SimulatedReplica();
      const rowanReplica = new SimulatedReplica();
      caseyReplica.apply(await pull(text, casey));
      rowanReplica.apply(await pull(text, rowan));
      expect(caseyReplica.rows.has(seen)).toBe(true);

      await sql.unsafe(
        `update ${flow.rows} set deleted_at = now(), version = version + 1 where id = any($1::uuid[])`,
        [[unseen, seen]],
      );
      const caseyChange = caseyReplica.apply(await pull(text, casey));
      const rowanChange = rowanReplica.apply(await pull(text, rowan));
      // Casey saw `seen`, so its tombstone arrives (deleted_at set); `unseen` never does.
      expect(caseyChange).toEqual({ put: [seen], remove: [] });
      expect(JSON.parse(caseyReplica.rows.get(seen) ?? '{}').deleted_at).not.toBeNull();
      expect(rowanChange).toEqual({ put: [], remove: [] });
      for (const payload of [...caseyReplica.payloads, ...rowanReplica.payloads]) {
        expect(payload).not.toContain(unseen);
        expect(payload).not.toContain('never revealed');
      }
    });

    test('Counts exclude hidden records: hidden rows change no player payload', async () => {
      if (sql === undefined) throw new Error('database unavailable');
      const { tables: flow } = await setup();
      const text = query(POLICIES[0] as ResourcePolicy, flow.rows, flow.members);
      const before = JSON.stringify(await pull(text, rowan));
      const hidden = Array.from({ length: 25 }, () => crypto.randomUUID());
      await insertJson(
        flow.rows,
        hidden.map((id, index) => ({
          id,
          campaign_id: campaignId,
          visibility_mode: index % 2 === 0 ? 'gm_only' : 'players',
          visibility_targets: index % 2 === 0 ? [] : [casey],
          author_user_id: null,
          deleted_at: index % 3 === 0 ? '2026-10-01T00:00:00Z' : null,
          version: 1,
          body: 'hidden',
        })),
      );
      expect(JSON.stringify(await pull(text, rowan))).toBe(before);
      await sql.unsafe(`delete from ${flow.rows} where id = any($1::uuid[])`, [hidden]);
      expect(JSON.stringify(await pull(text, rowan))).toBe(before);
    });

    test('Author-private notes never reach a GM-role replica', async () => {
      const { notes: flow } = await setup();
      const text = query(POLICIES[4] as ResourcePolicy, flow.rows, flow.members);
      const note = crypto.randomUUID();
      await insertJson(flow.rows, [
        {
          id: note,
          campaign_id: campaignId,
          visibility_mode: 'players',
          visibility_targets: [casey],
          author_user_id: casey,
          deleted_at: null,
          version: 1,
          body: 'Casey private note',
        },
      ]);
      expect((await pull(text, casey)).map((row) => row.id)).toEqual([note]);
      expect((await pull(text, gm)).length).toBe(0);
      expect((await pull(text, rowan)).length).toBe(0);
    });

    test('a removed member loses every campaign row on the next synchronization', async () => {
      if (sql === undefined) throw new Error('database unavailable');
      const { tables: flow } = await setup();
      const text = query(POLICIES[0] as ResourcePolicy, flow.rows, flow.members);
      const open = crypto.randomUUID();
      await insertJson(flow.rows, [
        {
          id: open,
          campaign_id: campaignId,
          visibility_mode: 'everyone',
          visibility_targets: [],
          author_user_id: null,
          deleted_at: null,
          version: 1,
          body: 'public handout',
        },
      ]);
      const replica = new SimulatedReplica();
      replica.apply(await pull(text, rowan));
      expect(replica.rows.has(open)).toBe(true);
      await sql.unsafe(`update ${flow.members} set removed_at = now() where user_id = $1`, [rowan]);
      const change = replica.apply(await pull(text, rowan));
      expect(change.put).toEqual([]);
      expect(change.remove).toContain(open);
      expect(replica.rows.size).toBe(0);
    });
  },
);
