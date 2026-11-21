import { afterAll, describe, expect, test } from 'bun:test';
import { ResourcePolicyRegistry } from '@rpg/authorization';
import type { Role } from '@rpg/contracts';
import {
  AUDIT_SYNC_WINDOW,
  compileAuditProviderQueries,
  type MembershipRelation,
  normalizeSql,
  POSTGRES_DIALECT,
} from '@rpg/sync';
import postgres from 'postgres';
import { membershipFactsSource } from '../audit/membership-facts.ts';
import { AuditTargetAccess } from '../audit/target-access.ts';
import type { ResourceFactsSource } from '../authorization/content-access.ts';
import { AUDIT_SYNC_STORES, registerResourcePolicies } from './sync-rules.ts';

/**
 * Feature 06 task 04: audit store replication.
 *
 * 1. Drift gate (no database): the `campaign_audit` and `gm_private_audit` stream queries in
 *    `infra/powersync/sync-config.yaml` equal `compileAuditProviderQueries` output, neither stream
 *    is subscribed by default, and the private table is addressed by the private stream only.
 * 2. Simulated replicas (PostgreSQL): the PostgreSQL rendering of the same rules runs on rolled-back
 *    shadow tables, and every requester (observers included) receives exactly the events the task 03
 *    read decision (`AuditTargetAccess`: current target facts, stored snapshot, private GM narrowing)
 *    permits, for every class the provider can prove; excluded and undeclared classes never sync.
 *
 * Named `.integration.test.ts` because it names feature 01/02 tables.
 */

const SYNC_CONFIG = new URL('../../../../../infra/powersync/sync-config.yaml', import.meta.url);

const MEMBERSHIP: MembershipRelation = {
  source: 'identity_campaign_memberships',
  userColumn: 'user_id',
  campaignColumn: 'campaign_id',
  roleColumn: 'role',
  removedAtColumn: 'removed_at',
};

function registry(): ResourcePolicyRegistry {
  return registerResourcePolicies(new ResourcePolicyRegistry());
}

interface StreamQuery {
  readonly stream: string;
  readonly autoSubscribe: boolean;
  readonly tables: readonly string[];
  readonly query: string;
}

function streamQueries(yaml: string): StreamQuery[] {
  const parsed = Bun.YAML.parse(yaml) as {
    readonly streams?: Record<
      string,
      { readonly auto_subscribe?: boolean; readonly query?: string; readonly queries?: string[] }
    >;
  };
  return Object.entries(parsed.streams ?? {}).flatMap(([stream, value]) =>
    [...(value.query === undefined ? [] : [value.query]), ...(value.queries ?? [])].map(
      (query) => ({
        stream,
        autoSubscribe: value.auto_subscribe === true,
        tables: [...query.matchAll(/\b(?:FROM|JOIN)\s+([a-z_][a-z0-9_]*)/gi)].map((match) =>
          (match[1] ?? '').toLowerCase(),
        ),
        query,
      }),
    ),
  );
}

/** Every difference between the configured audit streams and the compiled rules. */
function auditDrift(yaml: string): string[] {
  const { queries } = compileAuditProviderQueries(registry(), AUDIT_SYNC_STORES, MEMBERSHIP);
  const configured = streamQueries(yaml);
  const problems: string[] = [];
  for (const store of AUDIT_SYNC_STORES) {
    const expected = queries
      .filter((item) => item.store === store.store)
      .map((item) => normalizeSql(item.query))
      .sort();
    const actual = configured.filter((item) => item.tables.includes(store.source));
    for (const item of actual) {
      if (item.stream !== store.stream) {
        problems.push(`${store.source} addressed by stream ${item.stream}`);
      }
      if (item.autoSubscribe) problems.push(`${item.stream} is subscribed by default`);
    }
    const texts = actual.map((item) => normalizeSql(item.query)).sort();
    if (JSON.stringify(texts) !== JSON.stringify(expected)) {
      problems.push(
        `${store.stream}: queries differ from compiled output\nexpected: ${expected.join('\n')}\nactual:   ${texts.join('\n')}`,
      );
    }
  }
  return problems;
}

describe('audit streams match the compiled audit rules (feature 06 task 04)', () => {
  test('no drift; both stores in their own explicitly-subscribed stream', async () => {
    expect(auditDrift(await Bun.file(SYNC_CONFIG).text())).toEqual([]);
  });

  test('server-only targets stay online-only; the private store adds GM narrowing', () => {
    const compiled = compileAuditProviderQueries(registry(), AUDIT_SYNC_STORES, MEMBERSHIP);
    expect(compiled.excluded).toEqual([
      { targetClass: 'campaign_membership', reason: 'never_replicates' },
      // Feature 16: per-record content classes keep their audit history online-only.
      { targetClass: 'campaign_entity', reason: 'campaign_scope_unprovable' },
      { targetClass: 'personal_note', reason: 'ownership_on_read' },
      { targetClass: 'entity_relationship', reason: 'campaign_scope_unprovable' },
      // Feature 09: a roll is not an audit target at all (D-08); listed because the class replicates.
      { targetClass: 'dice_roll', reason: 'campaign_scope_unprovable' },
      // Feature 11: audit history of an application stays online-only, like per-record content.
      { targetClass: 'effect_application', reason: 'campaign_scope_unprovable' },
      // Feature 15: characters and their GM-only half keep their audit history online-only.
      { targetClass: 'character', reason: 'campaign_scope_unprovable' },
      { targetClass: 'character_secret', reason: 'campaign_scope_unprovable' },
      // Feature 18: session history stays online-only too.
      { targetClass: 'campaign_session', reason: 'campaign_scope_unprovable' },
      { targetClass: 'session_gm_note', reason: 'campaign_scope_unprovable' },
      { targetClass: 'session_log_entry', reason: 'campaign_scope_unprovable' },
      // Feature 19: encounter history stays online-only too.
      { targetClass: 'encounter', reason: 'campaign_scope_unprovable' },
      { targetClass: 'encounter_gm_note', reason: 'campaign_scope_unprovable' },
      { targetClass: 'encounter_participant', reason: 'campaign_scope_unprovable' },
      { targetClass: 'encounter_participant_state', reason: 'campaign_scope_unprovable' },
      // Feature 14: a member's own marks are never audited (D-10); the Ownership Rule covers read.
      { targetClass: 'rules_section_mark', reason: 'ownership_on_read' },
    ]);
    expect(compiled.queries.map((item) => [item.store, item.targetClass])).toEqual([
      ['campaign', 'campaign'],
      ['private', 'campaign'],
    ]);
    const [campaign, gmPrivate] = compiled.queries;
    expect(gmPrivate?.query.endsWith(`AND m.role IN '["owner","gm","assistant_gm"]'`)).toBe(true);
    expect(campaign?.query).not.toContain('audit_private_events');
    for (const item of compiled.queries) {
      // Sequence gaps would count hidden events; the snapshot names other targets.
      const selected = /^SELECT\s+([\s\S]*?)\s+FROM/i.exec(item.query)?.[1] ?? '';
      for (const column of ['campaign_sequence', 'target_visibility', 'origin_mutation_id']) {
        expect(selected).not.toContain(column);
      }
    }
  });

  test('a removed, widened, or misplaced filter is reported', async () => {
    const yaml = await Bun.file(SYNC_CONFIG).text();
    const privateNarrowing = `'["gm_only","players"]'))\n          AND m.role IN '["owner","gm","assistant_gm"]'`;
    const tampered = [
      // The private store reaches every reading role (players).
      yaml.replace(privateNarrowing, `'["gm_only","players"]'))`),
      // The stored snapshot is ignored (a GM-only event reaches players).
      yaml.replace(
        `AND (json_extract(audit_campaign_events.target_visibility, '$.visibility.mode') = 'everyone'`,
        `AND (true OR json_extract(audit_campaign_events.target_visibility, '$.visibility.mode') = 'everyone'`,
      ),
      // Events of a deleted target keep replicating.
      yaml.replace('AND campaigns.deleted_at IS NULL', ''),
      // The authority sequence (gaps count hidden events) is replicated.
      yaml.replace(
        'audit_campaign_events.renderer_version\n',
        'audit_campaign_events.renderer_version, audit_campaign_events.campaign_sequence\n',
      ),
      // The private stream is subscribed by default (a player replica addresses it).
      yaml.replace(
        'gm_private_audit:\n    auto_subscribe: false',
        'gm_private_audit:\n    auto_subscribe: true',
      ),
      // The private table is addressed by the campaign stream.
      yaml.replace(
        'campaign_audit:\n    auto_subscribe: false\n    queries:\n',
        'campaign_audit:\n    auto_subscribe: false\n    queries:\n      - SELECT audit_private_events.id FROM audit_private_events\n',
      ),
    ];
    for (const text of tampered) {
      expect(text).not.toBe(yaml);
      expect(auditDrift(text).length).toBeGreaterThan(0);
    }
  });
});

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const candidate =
  databaseUrl === undefined ? undefined : postgres(databaseUrl, { max: 2, onnotice: () => {} });
const sql = await (async () => {
  if (candidate === undefined) return undefined;
  try {
    await candidate`select 1 from audit_campaign_events limit 1`;
    return candidate;
  } catch {
    await candidate.end();
    return undefined;
  }
})();

afterAll(async () => sql?.end({ timeout: 1 }));

class Rollback extends Error {}

type Store = 'campaign' | 'private';

interface FixtureEvent {
  readonly id: string;
  readonly store: Store;
  readonly campaign: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly snapshot: unknown;
  readonly acceptedAt: string;
  readonly label: string;
}

/** Members, campaigns, and audit events in both stores, with the task 03 read decision. */
function auditFixture() {
  const id = () => crypto.randomUUID();
  const users = {
    owner: id(),
    gm: id(),
    assistant_gm: id(),
    player: id(),
    other_player: id(),
    observer: id(),
    removed_gm: id(),
    non_member: id(),
    other_campaign_owner: id(),
  };
  const campaign = id();
  const otherCampaign = id();
  const deletedCampaign = id();
  const memberships: { campaign: string; user: string; role: Role; removed: boolean }[] = [
    { campaign, user: users.owner, role: 'owner', removed: false },
    { campaign, user: users.gm, role: 'gm', removed: false },
    { campaign, user: users.assistant_gm, role: 'assistant_gm', removed: false },
    { campaign, user: users.player, role: 'player', removed: false },
    { campaign, user: users.other_player, role: 'player', removed: false },
    { campaign, user: users.observer, role: 'observer', removed: false },
    { campaign, user: users.removed_gm, role: 'gm', removed: true },
    { campaign: otherCampaign, user: users.other_campaign_owner, role: 'owner', removed: false },
    { campaign: deletedCampaign, user: users.player, role: 'player', removed: false },
    { campaign: deletedCampaign, user: users.owner, role: 'owner', removed: false },
  ];
  const campaigns = [
    { id: campaign, deleted: false },
    { id: otherCampaign, deleted: false },
    { id: deletedCampaign, deleted: true },
  ];
  const months = ['2026-09', '2026-10'];
  const snapshots: [string, unknown][] = [
    ['everyone', { visibility: { mode: 'everyone' } }],
    ['gm_only', { visibility: { mode: 'gm_only' } }],
    ['players:player', { visibility: { mode: 'players', playerIds: [users.player] } }],
    ['players:other', { visibility: { mode: 'players', playerIds: [users.other_player] } }],
    ['party', { visibility: { mode: 'party', partyIds: [id()] } }],
    // Extra keys do not widen: decided as `gm_only` by both sides.
    ['gm_only+ids', { visibility: { mode: 'gm_only', playerIds: [users.player] } }],
    ['invalid', { mode: 'everyone' }],
  ];
  const events: FixtureEvent[] = [];
  const add = (
    store: Store,
    campaignId: string,
    targetType: string,
    targetId: string,
    label: string,
    snapshot: unknown,
    month: string,
  ) =>
    events.push({
      id: id(),
      store,
      campaign: campaignId,
      targetType,
      targetId,
      snapshot,
      acceptedAt: `${month}-15T12:00:00Z`,
      label,
    });
  for (const store of ['campaign', 'private'] as const) {
    for (const month of months) {
      for (const [label, snapshot] of snapshots) {
        add(store, campaign, 'campaign', campaign, label, snapshot, month);
      }
      add(store, otherCampaign, 'campaign', otherCampaign, 'other', snapshots[0]?.[1], month);
      add(store, deletedCampaign, 'campaign', deletedCampaign, 'deleted', snapshots[0]?.[1], month);
      // A target in another campaign never resolves.
      add(store, campaign, 'campaign', otherCampaign, 'foreign', snapshots[0]?.[1], month);
      // Server-only class: readable online by GM roles, never replicated.
      add(
        store,
        campaign,
        'campaign_membership',
        users.player,
        'membership',
        {
          visibility: { mode: 'gm_only' },
        },
        month,
      );
      // Undeclared class: hidden everywhere.
      add(store, campaign, 'fixture.undeclared', id(), 'undeclared', snapshots[0]?.[1], month);
    }
  }

  const policies = registry();
  const campaignFacts: ResourceFactsSource = {
    resourceClass: 'campaign',
    loadFacts: async (campaignId, resourceId) => {
      const row = campaigns.find((item) => item.id === resourceId);
      return row === undefined || row.deleted || resourceId !== campaignId
        ? undefined
        : {
            campaignId,
            resourceClass: 'campaign',
            resourceId,
            visibility: { mode: 'everyone' },
            version: 1,
          };
    },
  };
  const membershipFacts = membershipFactsSource({
    historyFact: async (campaignId, userId) => {
      const row = memberships.find((item) => item.campaign === campaignId && item.user === userId);
      return row === undefined
        ? undefined
        : { campaignId, userId, version: 1, removed: row.removed };
    },
  });
  const access = new AuditTargetAccess({
    registry: policies,
    sources: [campaignFacts, membershipFacts],
  });
  const permitted = async (userId: string, store: Store, event: FixtureEvent) => {
    const membership = memberships.find(
      (item) => item.user === userId && item.campaign === event.campaign && !item.removed,
    );
    if (membership === undefined) return false;
    return access
      .readerFor({ userId, campaignId: event.campaign, role: membership.role }, store)
      .permits({
        targetType: event.targetType,
        targetId: event.targetId,
        snapshot: event.snapshot,
      });
  };

  return { id, users, campaign, memberships, campaigns, months, events, policies, permitted };
}

describe.skipIf(sql === undefined)('audit streams on simulated replicas (PostgreSQL)', () => {
  test('each requester receives exactly the events the task 03 read decision permits', async () => {
    if (sql === undefined) throw new Error('database unavailable');
    const { id, users, campaign, memberships, campaigns, months, events, policies, permitted } =
      auditFixture();
    const compiled = compileAuditProviderQueries(
      policies,
      AUDIT_SYNC_STORES,
      MEMBERSHIP,
      POSTGRES_DIALECT,
    );
    const sourceOf = (store: Store) =>
      AUDIT_SYNC_STORES.find((item) => item.store === store)?.source ?? '';
    let compared = 0;
    let apiOnly = 0;
    try {
      await sql.begin(async (tx) => {
        for (const table of [
          'campaigns',
          MEMBERSHIP.source,
          sourceOf('campaign'),
          sourceOf('private'),
        ]) {
          await tx.unsafe(
            `create temp table ${table} (like public.${table} including defaults) on commit drop`,
          );
        }
        for (const row of campaigns) {
          await tx`insert into campaigns (id, name, game_mode, created_by, deleted_at)
            values (${row.id}, 'Audit replica probe', 'standard', ${users.owner},
              ${row.deleted ? new Date('2026-10-01T00:00:00Z') : null})`;
        }
        for (const item of memberships) {
          await tx.unsafe(
            `insert into ${MEMBERSHIP.source} (campaign_id, user_id, role, removed_at)
              values ($1, $2, $3, $4)`,
            [item.campaign, item.user, item.role, item.removed ? new Date('2026-09-01') : null],
          );
        }
        let sequence = 0;
        for (const event of events) {
          sequence += 1;
          await tx.unsafe(
            `insert into ${sourceOf(event.store)} (id, campaign_id, campaign_sequence, actor_user_id,
               actor_role, action, target_type, target_id, target_visibility, client_recorded_at,
               accepted_at, origin_mutation_id, renderer_version)
             values ($1, $2, $3, $4, 'owner', 'probe.changed', $5, $6, $7::text::jsonb, $8, $8, $9, 0)`,
            [
              event.id,
              event.campaign,
              sequence,
              users.owner,
              event.targetType,
              event.targetId,
              JSON.stringify(event.snapshot),
              event.acceptedAt,
              id(),
            ],
          );
        }
        for (const userId of Object.values(users)) {
          for (const store of ['campaign', 'private'] as const) {
            const synced = new Set<string>();
            for (const query of compiled.queries.filter((item) => item.store === store)) {
              for (const campaignId of campaigns.map((item) => item.id)) {
                for (const month of months) {
                  const rows = await tx.unsafe<{ id: string; accepted_at: Date }[]>(query.query, [
                    userId,
                    campaignId,
                    month,
                  ]);
                  for (const row of rows) {
                    // The window delivers only the subscribed campaign and month.
                    const event = events.find((item) => item.id === row.id);
                    expect([event?.campaign, event?.acceptedAt.slice(0, 7)]).toEqual([
                      campaignId,
                      month,
                    ]);
                    synced.add(row.id);
                  }
                }
              }
            }
            for (const event of events.filter((item) => item.store === store)) {
              const api = await permitted(userId, store, event);
              const replicable = event.targetType === 'campaign';
              if (api && !replicable) apiOnly += 1;
              expect({ userId, store, event: event.label, synced: synced.has(event.id) }).toEqual({
                userId,
                store,
                event: event.label,
                synced: api && replicable,
              });
              compared += 1;
            }
          }
        }
        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
    expect(compared).toBe(Object.keys(users).length * events.length);
    // Membership events are readable online by the three GM roles in both stores, never synced.
    expect(apiOnly).toBe(3 * 2 * months.length);
    // Sanity on the oracle itself: a player reads `everyone` and own-targeted campaign events only.
    const playerView = await Promise.all(
      events
        .filter((event) => event.store === 'campaign' && event.campaign === campaign)
        .map(async (event) =>
          (await permitted(users.player, 'campaign', event)) ? event.label : '',
        ),
    );
    expect([...new Set(playerView.filter(Boolean))].sort()).toEqual(['everyone', 'players:player']);
    expect(AUDIT_SYNC_WINDOW).toEqual({ campaign: 'campaign_id', month: 'month' });
  });
});

/**
 * The PowerSync dialect itself, evaluated by the service's own sync-rules engine
 * (`infra/powersync/engine-check.mjs`, run in the service container) on the same fixture: every
 * requester, explicitly subscribed to both audit streams for every campaign and month (a player
 * included: the private stream's query, not the client, keeps it empty), receives exactly the
 * task 03 decision. Opt-in: `POWERSYNC_ENGINE_EXEC` (for example `wsl -e docker exec -i
 * rpg-powersync`).
 */
const ENGINE = process.env.POWERSYNC_ENGINE_EXEC?.trim().split(/\s+/) ?? [];

async function engine(input: Record<string, unknown>) {
  const child = Bun.spawn([...ENGINE, 'node', '/config/engine-check.mjs'], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, MSYS_NO_PATHCONV: '1' },
  });
  child.stdin.write(JSON.stringify(input));
  await child.stdin.end();
  const [out, err] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if ((await child.exited) !== 0) throw new Error(`engine-check failed: ${err.slice(0, 2000)}`);
  return JSON.parse(out.trim().split('\n').at(-1) ?? '') as {
    readonly diagnostics: { readonly type: string; readonly message: string }[];
    readonly errors?: string[];
    readonly delivered?: Record<string, string[]>;
  };
}

describe.skipIf(ENGINE.length === 0)('audit streams in the PowerSync sync-rules engine', () => {
  test('the configured streams deliver exactly the task 03 read decision', async () => {
    const { users, memberships, campaigns, months, events, permitted } = auditFixture();
    const yaml = await Bun.file(SYNC_CONFIG).text();
    const subscription = Object.fromEntries(
      Object.values(users).map((userId) => [
        userId,
        Object.fromEntries(
          AUDIT_SYNC_STORES.map((store) => [
            store.stream,
            campaigns.flatMap((row) =>
              months.map((month) => ({
                [AUDIT_SYNC_WINDOW.campaign]: row.id,
                [AUDIT_SYNC_WINDOW.month]: month,
              })),
            ),
          ]),
        ),
      ]),
    );
    let compared = 0;
    for (const store of AUDIT_SYNC_STORES) {
      const rows = events
        .filter((event) => event.store === store.store)
        .map((event) => ({
          id: event.id,
          campaign_id: event.campaign,
          target_type: event.targetType,
          target_id: event.targetId,
          target_visibility: JSON.stringify(event.snapshot),
          accepted_at: event.acceptedAt,
          action: 'probe.changed',
        }));
      const result = await engine({
        yaml,
        rowTable: store.source,
        rows,
        parameterTables: [
          {
            table: MEMBERSHIP.source,
            rows: memberships.map((item, index) => ({
              id: String(index),
              campaign_id: item.campaign,
              user_id: item.user,
              role: item.role,
              removed_at: item.removed ? '2026-09-01T00:00:00Z' : null,
            })),
          },
          {
            table: 'campaigns',
            rows: campaigns.map((item) => ({
              id: item.id,
              deleted_at: item.deleted ? '2026-10-01T00:00:00Z' : null,
            })),
          },
        ],
        users: Object.values(users),
        subscriptions: subscription,
      });
      expect(result.diagnostics).toEqual([]);
      expect(result.errors ?? []).toEqual([]);
      for (const userId of Object.values(users)) {
        const delivered = new Set(result.delivered?.[userId] ?? []);
        for (const event of events.filter((item) => item.store === store.store)) {
          const api = await permitted(userId, store.store, event);
          expect({
            userId,
            store: store.store,
            event: event.label,
            synced: delivered.has(event.id),
          }).toEqual({
            userId,
            store: store.store,
            event: event.label,
            synced: api && event.targetType === 'campaign',
          });
          compared += 1;
        }
      }
    }
    expect(compared).toBe(Object.keys(users).length * events.length);
  });
});
