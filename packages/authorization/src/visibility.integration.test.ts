import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  AccountAuditRepository,
  type AuditDatabase,
  type AuditDiagnostics,
  AuditRendererRegistry,
  CampaignAuditRepository,
  connectAuditDatabase,
  DurableAuditRecorder,
  PostgresAuditRepairOutbox,
  PrivateAuditRepository,
} from '@rpg/audit';
import { type ActorRef, err, ok, type Role, type Visibility } from '@rpg/contracts';
import { sql } from 'drizzle-orm';
import {
  type ResourceFacts,
  ResourcePolicyRegistry,
  runVisibilityAdapterContract,
  type VisibilityActorResolver,
  type VisibilityAdapter,
  type VisibilityChange,
  type VisibilityChangeResult,
  VisibilityService,
  type VisibilityWrite,
  type VisibilityWriteResult,
  visibilityFromColumns,
  visibilityToColumns,
} from './index.ts';

/**
 * `_db.md` Required Data Tests against PostgreSQL. No content-owner table exists yet, so this
 * suite creates (and drops) a uniquely named table with the standard Visibility columns and
 * checks, plus the owner adapter a real content feature would write. Audit uses the real feature
 * 06 stores through `recordWithin`, inside the adapter's transaction.
 */

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const candidate = databaseUrl === undefined ? undefined : connectAuditDatabase(databaseUrl);
const connection = await (async () => {
  if (candidate === undefined) return undefined;
  try {
    await candidate.db.execute(sql`select 1 from audit_campaign_events limit 1`);
    return candidate;
  } catch {
    await candidate.close();
    return undefined;
  }
})();

const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 12);
const TABLE = `authz_visibility_test_${suffix}`;
const TARGETS_FN = `authz_visibility_targets_ok_${suffix}`;
const RESOURCE_CLASS = 'fixture.visibility_record';

function db(): AuditDatabase {
  if (connection === undefined) throw new Error('database unavailable');
  return connection.db;
}

beforeAll(async () => {
  if (connection === undefined) return;
  // Sorted (COLLATE "C", same as JS code-unit order), unique, lowercase UUID strings.
  await db().execute(
    sql.raw(`create function ${TARGETS_FN}(targets jsonb) returns boolean
      language sql immutable as $$
        select case when jsonb_typeof(targets) <> 'array' then false else not exists (
          select 1 from (
            select element, lag(element) over (order by position) as previous
            from jsonb_array_elements(targets) with ordinality as item(element, position)
          ) as ordered
          where jsonb_typeof(element) <> 'string'
            or (element #>> '{}') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            or (previous is not null
              and (element #>> '{}') collate "C" <= (previous #>> '{}') collate "C")
        ) end
      $$`),
  );
  await db().execute(
    sql.raw(`create table ${TABLE} (
      id uuid primary key,
      campaign_id uuid not null,
      visibility_mode text not null,
      visibility_targets jsonb not null default '[]'::jsonb,
      version bigint not null default 1,
      deleted_at timestamptz,
      constraint ${TABLE}_mode_check
        check (visibility_mode in ('gm_only', 'everyone', 'party', 'players')),
      constraint ${TABLE}_targets_check check (case
        when not ${TARGETS_FN}(visibility_targets) then false
        when visibility_mode in ('gm_only', 'everyone') then visibility_targets = '[]'::jsonb
        else jsonb_array_length(visibility_targets) > 0 end),
      constraint ${TABLE}_version_check check (version >= 1)
    )`),
  );
});

afterAll(async () => {
  if (connection === undefined) return;
  await db().execute(sql.raw(`drop table if exists ${TABLE}`));
  await db().execute(sql.raw(`drop function if exists ${TARGETS_FN}(jsonb)`));
  await connection.close();
});

interface VisibilityRow {
  readonly visibility_mode: unknown;
  readonly visibility_targets: unknown;
  readonly version: unknown;
}

function jsonValue(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

/** What a content owner would ship: one conditional UPDATE, audit in the same transaction. */
class TestTableAdapter implements VisibilityAdapter {
  readonly resourceClass = RESOURCE_CLASS;

  constructor(private readonly options: { readonly failAfterAudit?: boolean } = {}) {}

  async loadFacts(campaignId: string, resourceId: string): Promise<ResourceFacts | undefined> {
    const rows = (await db().execute(
      sql`select visibility_mode, visibility_targets, version from ${sql.identifier(TABLE)}
          where id = ${resourceId} and campaign_id = ${campaignId} and deleted_at is null`,
    )) as unknown as VisibilityRow[];
    const row = rows[0];
    return row === undefined ? undefined : this.facts(campaignId, resourceId, row);
  }

  writeVisibility(write: VisibilityWrite): Promise<VisibilityWriteResult> {
    const columns = visibilityToColumns(write.visibility);
    return db().transaction(async (transaction): Promise<VisibilityWriteResult> => {
      const updated = (await transaction.execute(
        sql`update ${sql.identifier(TABLE)}
            set visibility_mode = ${columns.mode},
                visibility_targets = ${JSON.stringify(columns.targets)}::jsonb,
                version = version + 1
            where id = ${write.resourceId} and campaign_id = ${write.campaignId}
              and deleted_at is null and version = ${write.expectedVersion}
            returning visibility_mode, visibility_targets, version`,
      )) as unknown as VisibilityRow[];
      const row = updated[0];
      if (row === undefined) {
        const live = (await transaction.execute(
          sql`select 1 from ${sql.identifier(TABLE)}
              where id = ${write.resourceId} and campaign_id = ${write.campaignId}
                and deleted_at is null`,
        )) as unknown as unknown[];
        return { ok: false, reason: live.length > 0 ? 'version_conflict' : 'not_found' };
      }
      await write.recordAudit(transaction);
      if (this.options.failAfterAudit === true) throw new Error('domain failure after audit');
      return { ok: true, facts: this.facts(write.campaignId, write.resourceId, row) };
    });
  }

  private facts(campaignId: string, resourceId: string, row: VisibilityRow): ResourceFacts {
    const visibility = visibilityFromColumns(
      row.visibility_mode,
      jsonValue(row.visibility_targets),
    );
    if (visibility === undefined) throw new Error('non-canonical stored visibility');
    return {
      campaignId,
      resourceClass: RESOURCE_CLASS,
      resourceId,
      visibility,
      version: Number(row.version),
    };
  }
}

async function seed(campaignId: string, visibility: Visibility, version = 1): Promise<string> {
  const id = crypto.randomUUID();
  const columns = visibilityToColumns(visibility);
  await db().execute(
    sql`insert into ${sql.identifier(TABLE)}
          (id, campaign_id, visibility_mode, visibility_targets, version)
        values (${id}, ${campaignId}, ${columns.mode}, ${JSON.stringify(columns.targets)}::jsonb,
          ${version})`,
  );
  return id;
}

async function stored(id: string) {
  const rows = (await db().execute(
    sql`select visibility_mode, visibility_targets, version from ${sql.identifier(TABLE)}
        where id = ${id}`,
  )) as unknown as VisibilityRow[];
  const row = rows[0];
  return row === undefined
    ? undefined
    : {
        mode: row.visibility_mode,
        targets: jsonValue(row.visibility_targets),
        version: Number(row.version),
      };
}

interface AuditRow {
  readonly action: string;
  readonly actor_user_id: string;
  readonly actor_role: string;
  readonly before_value: unknown;
  readonly after_value: unknown;
  readonly target_visibility: unknown;
  readonly origin_mutation_id: string;
}

async function auditRows(targetId: string): Promise<AuditRow[]> {
  const campaign = (await db().execute(
    sql`select action, actor_user_id, actor_role, before_value, after_value, target_visibility,
          origin_mutation_id
        from audit_campaign_events where target_id = ${targetId} order by campaign_sequence`,
  )) as unknown as AuditRow[];
  const privateRows = (await db().execute(
    sql`select 1 from audit_private_events where target_id = ${targetId}`,
  )) as unknown as unknown[];
  expect(privateRows).toHaveLength(0);
  return campaign;
}

function codeOf(error: unknown): string | undefined {
  let current: unknown = error;
  while (typeof current === 'object' && current !== null) {
    if ('code' in current && typeof current.code === 'string') return current.code;
    current = 'cause' in current ? current.cause : undefined;
  }
  return undefined;
}

class Members implements VisibilityActorResolver {
  private readonly roles = new Map<string, Role>();

  add(campaignId: string, userId: string, role: Role): string {
    this.roles.set(`${campaignId}:${userId}`, role);
    return userId;
  }

  async resolve(userId: string, campaignId: string) {
    const role = this.roles.get(`${campaignId}:${userId}`);
    return role === undefined
      ? err('membership_not_found' as const)
      : ok<ActorRef>({ userId, campaignId, role });
  }
}

describe.skipIf(connection === undefined)('PostgreSQL visibility mutation', () => {
  const signals: unknown[] = [];
  const diagnostics: AuditDiagnostics = {
    degraded: (signal) => signals.push(signal),
    deadLettered: (signal) => signals.push(signal),
    repaired: (signal) => signals.push(signal),
  };

  function world(adapter: VisibilityAdapter = new TestTableAdapter()) {
    const campaignId = crypto.randomUUID();
    const members = new Members();
    const gm = members.add(campaignId, crypto.randomUUID(), 'gm');
    const gmTwo = members.add(campaignId, crypto.randomUUID(), 'assistant_gm');
    const [casey, rowan] = [crypto.randomUUID(), crypto.randomUUID()].sort();
    if (casey === undefined || rowan === undefined) throw new Error('ids');
    members.add(campaignId, casey, 'player');
    members.add(campaignId, rowan, 'player');
    const registry = new ResourcePolicyRegistry({ requireVisibilityAdapters: true });
    registry.register(
      {
        resourceClass: RESOURCE_CLASS,
        capabilities: ['read', 'reveal'],
        roleCapabilities: {
          owner: ['read', 'reveal'],
          gm: ['read', 'reveal'],
          assistant_gm: ['read', 'reveal'],
          player: ['read'],
          observer: [],
        },
        defaultVisibility: { mode: 'gm_only' },
        sync: {
          kind: 'replicated',
          source: TABLE,
          campaignColumn: 'campaign_id',
          visibility: { modeColumn: 'visibility_mode', targetsColumn: 'visibility_targets' },
          deletedAtColumn: 'deleted_at',
        },
      },
      adapter,
    );
    const recorder = new DurableAuditRecorder({
      campaign: new CampaignAuditRepository(db()),
      private: new PrivateAuditRepository(db()),
      account: new AccountAuditRepository(db()),
      outbox: new PostgresAuditRepairOutbox(db()),
      registry: new AuditRendererRegistry(),
      diagnostics,
    });
    const service = new VisibilityService({ registry, actors: members, audit: recorder });
    const request = (
      resourceId: string,
      overrides: Partial<VisibilityChange> = {},
    ): VisibilityChange => ({
      campaignId,
      resourceClass: RESOURCE_CLASS,
      resourceId,
      operation: 'reveal',
      target: { mode: 'players', playerIds: [casey] },
      expectedVersion: 1,
      ...overrides,
    });
    return { campaignId, gm, gmTwo, casey, rowan, service, request };
  }

  test('database checks reject invalid mode/target combinations and duplicates', async () => {
    const campaignId = crypto.randomUUID();
    const [a, b] = [crypto.randomUUID(), crypto.randomUUID()].sort();
    const insert = (mode: string, targets: string) =>
      db().execute(
        sql`insert into ${sql.identifier(TABLE)}
              (id, campaign_id, visibility_mode, visibility_targets)
            values (${crypto.randomUUID()}, ${campaignId}, ${mode}, ${targets}::jsonb)`,
      );
    const invalid: readonly (readonly [string, string])[] = [
      ['players', '[]'],
      ['party', '[]'],
      ['gm_only', JSON.stringify([a])],
      ['everyone', JSON.stringify([a])],
      ['players', JSON.stringify([b, a])],
      ['players', JSON.stringify([a, a])],
      ['players', JSON.stringify([a?.toUpperCase()])],
      ['players', '["not-a-uuid"]'],
      ['players', '[1]'],
      ['players', '{}'],
      ['secret', '[]'],
    ];
    for (const [mode, targets] of invalid) {
      let code: string | undefined = 'no_error';
      try {
        await insert(mode, targets);
      } catch (error) {
        code = codeOf(error);
      }
      expect({ mode, targets, code }).toEqual({ mode, targets, code: '23514' });
    }
    for (const [mode, targets] of [
      ['gm_only', '[]'],
      ['everyone', '[]'],
      ['players', JSON.stringify([a, b])],
      ['party', JSON.stringify([a])],
    ] as const) {
      await insert(mode, targets);
    }
  });

  test('the test-table owner adapter passes the shared adapter contract', async () => {
    const report = await runVisibilityAdapterContract({
      adapter: new TestTableAdapter(),
      seed: ({ campaignId, visibility }) => seed(campaignId, visibility),
      tombstone: async (campaignId, resourceId) => {
        await db().execute(
          sql`update ${sql.identifier(TABLE)} set deleted_at = now()
              where id = ${resourceId} and campaign_id = ${campaignId}`,
        );
      },
    });
    expect(report.findings).toEqual([]);
    expect(report.checks).toHaveLength(10);
  });

  test('reveal, additive reveal, duplicate reveal, and un-reveal persist normalized and audit once each', async () => {
    const { campaignId, gm, casey, rowan, service, request } = world();
    const id = await seed(campaignId, { mode: 'gm_only' });
    const signalsBefore = signals.length;

    expect((await service.change(gm, request(id))).status).toBe('changed');
    expect(await stored(id)).toEqual({ mode: 'players', targets: [casey], version: 2 });

    const additive = await service.change(
      gm,
      request(id, { target: { mode: 'players', playerIds: [rowan, rowan] }, expectedVersion: 2 }),
    );
    expect(additive).toMatchObject({ status: 'changed', audit: 'within_transaction' });
    expect(await stored(id)).toEqual({ mode: 'players', targets: [casey, rowan], version: 3 });

    const duplicate = await service.change(gm, request(id, { expectedVersion: 3 }));
    expect(duplicate.status).toBe('unchanged');
    expect(await stored(id)).toEqual({ mode: 'players', targets: [casey, rowan], version: 3 });

    const unrevealed = await service.change(
      gm,
      request(id, {
        operation: 'unreveal',
        target: { mode: 'players', playerIds: [rowan, casey] },
        expectedVersion: 3,
      }),
    );
    expect(unrevealed.status).toBe('changed');
    expect(await stored(id)).toEqual({ mode: 'gm_only', targets: [], version: 4 });

    const rows = await auditRows(id);
    expect(rows.map((row) => row.action)).toEqual([
      'visibility.revealed',
      'visibility.revealed',
      'visibility.unrevealed',
    ]);
    expect(rows.every((row) => row.actor_user_id === gm && row.actor_role === 'gm')).toBe(true);
    expect(rows.map((row) => [jsonValue(row.before_value), jsonValue(row.after_value)])).toEqual([
      [
        { visibility: { mode: 'gm_only' }, version: 1 },
        { visibility: { mode: 'players', playerIds: [casey] }, version: 2 },
      ],
      [
        { visibility: { mode: 'players', playerIds: [casey] }, version: 2 },
        { visibility: { mode: 'players', playerIds: [casey, rowan] }, version: 3 },
      ],
      [
        { visibility: { mode: 'players', playerIds: [casey, rowan] }, version: 3 },
        { visibility: { mode: 'gm_only' }, version: 4 },
      ],
    ]);
    expect(rows.map((row) => jsonValue(row.target_visibility))).toEqual(
      rows.map(() => ({ visibility: { mode: 'gm_only' } })),
    );
    expect(signals.length).toBe(signalsBefore);
  });

  test('non-member targets and unauthorized actors leave the record and audit unchanged', async () => {
    const { campaignId, gm, casey, rowan, service, request } = world();
    const id = await seed(campaignId, { mode: 'players', playerIds: [casey] });
    const outsider = crypto.randomUUID();

    const nonMember = await service.change(
      gm,
      request(id, { target: { mode: 'players', playerIds: [rowan, outsider] } }),
    );
    expect(nonMember).toEqual({ status: 'rejected', reason: 'target_not_member' });

    const byPlayer: VisibilityChangeResult = await service.change(
      casey,
      request(id, { target: { mode: 'players', playerIds: [rowan] } }),
    );
    expect(byPlayer.status === 'rejected' && byPlayer.reason).toBe('denied');

    const byOutsider = await service.change(outsider, request(id));
    expect(byOutsider).toEqual({ status: 'rejected', reason: 'actor_not_member' });

    expect(await stored(id)).toEqual({ mode: 'players', targets: [casey], version: 1 });
    expect(await auditRows(id)).toHaveLength(0);
  });

  test('concurrent reveals on one version: one winner, one explicit conflict, no lost grant', async () => {
    const races = await Promise.all(
      Array.from({ length: 5 }, async () => {
        const { campaignId, gm, gmTwo, casey, rowan, service, request } = world();
        const id = await seed(campaignId, { mode: 'gm_only' }, 4);
        const results = await Promise.all([
          service.change(gm, request(id, { expectedVersion: 4 })),
          service.change(
            gmTwo,
            request(id, { target: { mode: 'players', playerIds: [rowan] }, expectedVersion: 4 }),
          ),
        ]);
        return { id, casey, rowan, results };
      }),
    );
    for (const { id, casey, rowan, results } of races) {
      expect(results.map((result) => result.status).sort()).toEqual(['changed', 'conflict']);
      const winner = results[0]?.status === 'changed' ? casey : rowan;
      expect(await stored(id)).toEqual({ mode: 'players', targets: [winner], version: 5 });
      const rows = await auditRows(id);
      expect(rows).toHaveLength(1);
      expect(jsonValue(rows[0]?.after_value)).toEqual({
        visibility: { mode: 'players', playerIds: [winner] },
        version: 5,
      });
    }
  });

  test('a failed domain transaction rolls back both the Visibility update and its audit event', async () => {
    const { campaignId, gm, service, request } = world(
      new TestTableAdapter({ failAfterAudit: true }),
    );
    const id = await seed(campaignId, { mode: 'gm_only' });
    let message: string | undefined = 'no_error';
    try {
      await service.change(gm, request(id, { mutationId: crypto.randomUUID() }));
    } catch (error) {
      message = error instanceof Error ? error.message : 'unknown';
    }
    expect(message).toBe('domain failure after audit');
    expect(await stored(id)).toEqual({ mode: 'gm_only', targets: [], version: 1 });
    expect(await auditRows(id)).toHaveLength(0);
  });
});
