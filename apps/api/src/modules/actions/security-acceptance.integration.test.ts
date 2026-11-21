import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  ACTIONS_SYNC_FEATURE_ID,
  EFFECT_RECORD_TYPE,
  EFFECT_REPLICA_TABLE,
  type EffectRecord,
  effectDisplayName,
  type PlannedOperation,
} from '@rpg/actions';
import {
  connectActionsDatabase,
  type EffectTargetAdapter,
  PostgresEffectRepository,
} from '@rpg/actions/postgres';
import { runEffectTargetContract } from '@rpg/actions/testing';
import { visibilityFromColumns, visibilityToColumns } from '@rpg/authorization';
import type { Role, Visibility } from '@rpg/contracts';
import { FIXTURE_SYSTEM_DEFINITION } from '@rpg/fixtures';
import { sql as drizzleSql } from 'drizzle-orm';
import postgres from 'postgres';
import { buildRuntimeApp } from '../../runtime.ts';

/**
 * Feature 11 acceptance on PostgreSQL through the real composition root. No owner of target state exists
 * yet (D-13), so a probe table stands in: a thin adapter, as feature 15's will be, under two different
 * target classes with real feature 04 rules (`campaign_entity`: GM roles update; `personal_note`: the
 * author only). The table is created here and dropped afterwards; applications and receipts are deleted.
 */

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const origin = 'https://table.invalid';
const sql =
  databaseUrl === undefined
    ? undefined
    : postgres(databaseUrl, { max: 2, onnotice: () => undefined });
const db = sql as NonNullable<typeof sql>;
const available = await (async () => {
  if (sql === undefined) return false;
  try {
    await sql`select 1 from effect_applications limit 1`;
    return true;
  } catch {
    return false;
  }
})();
const campaigns: string[] = [];

beforeAll(async () => {
  if (!available) return;
  await db`create table if not exists effect_probe_targets (
    id uuid primary key,
    campaign_id uuid not null,
    owner uuid not null,
    state jsonb not null,
    visibility_mode text not null,
    visibility_targets jsonb not null default '[]'
  )`;
});

afterAll(async () => {
  if (available) {
    await db`drop table if exists effect_probe_targets`;
    if (campaigns.length > 0) {
      await db`delete from effect_applications where campaign_id = any(${campaigns}::uuid[])`;
      await db`delete from sync_mutation_receipts where campaign_id = any(${campaigns}::uuid[])`;
    }
  }
  await sql?.end({ timeout: 1 });
});

const SYNC_CONFIG = new URL('../../../../../infra/powersync/sync-config.yaml', import.meta.url);

async function effectsQuery(): Promise<string> {
  const parsed = Bun.YAML.parse(await Bun.file(SYNC_CONFIG).text()) as {
    readonly streams: Record<string, { readonly queries?: string[] }>;
  };
  const query = parsed.streams.authorized_effects?.queries?.[0];
  if (query === undefined) throw new Error('no effects stream');
  return query
    .replace(
      /auth\.user_id\(\) IN ([a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*)/g,
      (_match, column: string) => `${column} @> jsonb_build_array($1::uuid)`,
    )
    .replaceAll('auth.user_id()', '$1::uuid')
    .replace(
      /IN '(\[[^']*\])'/g,
      (_match, values: string) =>
        `IN (${(JSON.parse(values) as string[]).map((value) => `'${value}'`).join(', ')})`,
    );
}

const FAULT = { armed: false };
const HIDDEN_PREFIX = 'resources.secret.';

function probeAdapter(targetClass: string): EffectTargetAdapter {
  return {
    targetClass,
    load: async (transaction, { campaignId, targetId }) => {
      const rows = (await transaction.execute(drizzleSql`
        select owner, state, visibility_mode, visibility_targets from effect_probe_targets
        where id = ${targetId} and campaign_id = ${campaignId} for update`)) as unknown as {
        owner: string;
        state: never;
        visibility_mode: string;
        visibility_targets: unknown;
      }[];
      const [row] = rows;
      if (row === undefined) return undefined;
      const visibility = visibilityFromColumns(row.visibility_mode, row.visibility_targets);
      if (visibility === undefined) return undefined;
      return {
        state: row.state,
        facts: {
          campaignId,
          resourceClass: targetClass,
          resourceId: targetId,
          visibility,
          version: 1,
          authorUserId: row.owner,
        },
      };
    },
    save: async (transaction, { campaignId, targetId, state }) => {
      if (FAULT.armed) throw new Error('target write fault');
      await transaction.execute(drizzleSql`
        update effect_probe_targets set state = ${JSON.stringify(state)}::jsonb
        where id = ${targetId} and campaign_id = ${campaignId}`);
    },
    deniedPaths: (_actor, paths) => paths.filter((path) => path === 'fields.locked'),
    hiddenPaths: (paths) => paths.filter((path) => path.startsWith(HIDDEN_PREFIX)),
    constrain: (state) => {
      const hp = state.resources.hp;
      return hp !== undefined && hp.current > 99
        ? { ...state, resources: { ...state.resources, hp: { ...hp, current: 99 } } }
        : state;
    },
  };
}

type Who = { readonly id: string; readonly headers: Record<string, string> };
let sequence = 0;

async function runtime() {
  if (databaseUrl === undefined) throw new Error('database unavailable');
  const app = buildRuntimeApp({
    databaseUrl,
    allowedOrigin: origin,
    production: false,
    powerSyncEndpoint: 'http://localhost:8080',
    powerSyncJwtSecret: 'ZGV2ZWxvcG1lbnQtb25seS1wb3dlcnN5bmMta2V5LTMyIQ',
    systems: [FIXTURE_SYSTEM_DEFINITION],
    logger: false,
    effectTargets: [probeAdapter('campaign_entity'), probeAdapter('personal_note')],
  });
  await app.ready();
  const suffix = crypto.randomUUID().slice(0, 8);
  let counter = 0;
  const signUp = async (): Promise<Who> => {
    counter += 1;
    const account = await app.inject({
      method: 'POST',
      url: '/auth/accounts',
      payload: { username: `fx_${suffix}_${counter}`, password: 'correct horse battery staple' },
    });
    expect(account.statusCode).toBe(200);
    const raw = account.headers['set-cookie'];
    return {
      id: (JSON.parse(account.body) as { user: { id: string } }).user.id,
      headers: { cookie: ((Array.isArray(raw) ? raw[0] : raw) ?? '').split(';')[0] ?? '', origin },
    };
  };
  const createCampaign = async (owner: Who) => {
    const campaignId = crypto.randomUUID();
    campaigns.push(campaignId);
    const created = await app.inject({
      method: 'POST',
      url: '/campaigns',
      headers: owner.headers,
      payload: {
        id: campaignId,
        system: FIXTURE_SYSTEM_DEFINITION.summary.ref,
        gameMode: 'standard',
        options: {},
        moduleIds: [],
        name: 'Effect acceptance',
        description: '',
      },
    });
    expect(created.statusCode).toBe(201);
    return campaignId;
  };
  const invite = async (owner: Who, campaignId: string, member: Who, role: Role) => {
    const invited = await app.inject({
      method: 'POST',
      url: `/campaigns/${campaignId}/invitations`,
      headers: owner.headers,
      payload: { targetRole: role },
    });
    expect(invited.statusCode).toBe(201);
    const accepted = await app.inject({
      method: 'POST',
      url: `/invitations/${(invited.json() as { token: string }).token}/accept`,
      headers: member.headers,
    });
    expect(accepted.statusCode).toBe(200);
  };
  const upload = async (
    who: Who,
    campaignId: string,
    recordId: string,
    payload: unknown,
    options: {
      readonly operation?: 'insert' | 'update' | 'tombstone';
      readonly expectedVersion?: number | null;
      readonly mutationId?: string;
      readonly audit?: boolean;
    } = {},
  ) => {
    sequence += 1;
    const at = new Date().toISOString();
    const response = await app.inject({
      method: 'POST',
      url: '/sync/mutations',
      headers: who.headers,
      payload: {
        campaignId,
        replicaId: crypto.randomUUID(),
        mutations: [
          {
            mutationId: options.mutationId ?? crypto.randomUUID(),
            campaignId,
            featureId: ACTIONS_SYNC_FEATURE_ID,
            tableName: EFFECT_REPLICA_TABLE,
            recordId,
            operation: options.operation ?? 'insert',
            expectedVersion: options.expectedVersion ?? null,
            payload,
            ...(options.audit !== true
              ? {}
              : {
                  audit: {
                    campaignId,
                    action: 'actions.created',
                    targetType: EFFECT_REPLICA_TABLE,
                    targetId: recordId,
                    at,
                    private: false,
                  },
                }),
            causalSequence: sequence,
            state: 'pending',
            attemptCount: 0,
            recordedAt: at,
          },
        ],
      },
    });
    expect(response.statusCode).toBe(200);
    return (response.json() as { outcomes: Record<string, unknown>[] }).outcomes[0] as {
      status: string;
      code?: string;
      retryable?: boolean;
      acceptedVersion?: number;
    };
  };
  const send = (who: Who, record: EffectRecord, options: Parameters<typeof upload>[4] = {}) =>
    upload(who, record.campaignId, record.id, record, options);
  return { app, signUp, createCampaign, invite, upload, send };
}

async function seedTarget(
  campaignId: string,
  owner: string,
  state: unknown,
  visibility: Visibility = { mode: 'everyone' },
): Promise<string> {
  const id = crypto.randomUUID();
  const columns = visibilityToColumns(visibility);
  await db`insert into effect_probe_targets (id, campaign_id, owner, state, visibility_mode,
      visibility_targets)
    values (${id}, ${campaignId}, ${owner}, ${db.json(state as never)}, ${columns.mode},
      ${db.json([...columns.targets])})`;
  return id;
}

const EMPTY = { fields: {}, resources: {}, tracks: {}, conditions: {}, inventory: {}, slots: {} };

function withHp(current: number) {
  return { ...EMPTY, resources: { hp: { current } } };
}

async function hpOf(targetId: string): Promise<number> {
  const [row] = await db<{ current: number }[]>`
    select (state->'resources'->'hp'->>'current')::int as current
    from effect_probe_targets where id = ${targetId}`;
  return row?.current ?? Number.NaN;
}

function application(
  who: Who,
  campaignId: string,
  targetId: string,
  operations: readonly PlannedOperation[],
  overrides: Partial<EffectRecord> = {},
): EffectRecord {
  const at = '2026-11-01T12:00:00.000Z';
  return {
    id: crypto.randomUUID(),
    campaignId,
    type: EFFECT_RECORD_TYPE,
    name: effectDisplayName(overrides.action),
    tags: [],
    metadata: {},
    visibility: { mode: 'everyone' },
    version: 1,
    createdAt: at,
    createdBy: who.id,
    updatedAt: at,
    updatedBy: who.id,
    actorUserId: who.id,
    targetClass: 'campaign_entity',
    targetId,
    operations,
    changes: [],
    edited: false,
    appliedAt: at,
    ...overrides,
  };
}

function hpDelta(value: number): readonly PlannedOperation[] {
  const path = 'resources.hp.current';
  return [
    { operation: { op: 'delta', path, value } },
    { operation: { op: 'clamp', path, min: 0, max: 20 } },
  ];
}

async function rowCount(id: string): Promise<number> {
  const [row] = await db<{ count: number }[]>`
    select count(*)::int as count from effect_applications where id = ${id}`;
  return row?.count ?? 0;
}

describe.skipIf(!available)('feature 11 acceptance', () => {
  test('concurrent offline damage and healing merge, in either order', async () => {
    const h = await runtime();
    try {
      const gm = await h.signUp();
      const campaign = await h.createCampaign(gm);
      for (const order of [
        [-3, 2],
        [2, -3],
      ] as const) {
        const target = await seedTarget(campaign, gm.id, withHp(10));
        for (const value of order) {
          const record = application(gm, campaign, target, hpDelta(value));
          expect(await h.send(gm, record)).toMatchObject({ status: 'accepted' });
        }
        expect(await hpOf(target)).toBe(9);
      }
    } finally {
      await h.app.close();
    }
  }, 60_000);

  test('a replayed application never doubles', async () => {
    const h = await runtime();
    try {
      const gm = await h.signUp();
      const campaign = await h.createCampaign(gm);
      const target = await seedTarget(campaign, gm.id, withHp(10));
      const record = application(gm, campaign, target, hpDelta(-3), { action: 'hit' });
      const mutationId = crypto.randomUUID();
      const first = await h.send(gm, record, { mutationId });
      expect(first).toMatchObject({ status: 'accepted', acceptedVersion: 1 });
      expect(await h.send(gm, record, { mutationId })).toEqual(first);
      expect(await h.send(gm, record)).toMatchObject({ status: 'accepted', acceptedVersion: 1 });
      expect(await hpOf(target)).toBe(7);
      expect(await rowCount(record.id)).toBe(1);

      const other = application(gm, campaign, target, hpDelta(-9), { id: record.id });
      expect(await h.send(gm, other)).toEqual(
        expect.objectContaining({ status: 'error', code: 'not_found_or_forbidden' }),
      );
      expect(await hpOf(target)).toBe(7);
    } finally {
      await h.app.close();
    }
  }, 60_000);

  test('a guard refuses the second spend of the last point, whole', async () => {
    const h = await runtime();
    try {
      const gm = await h.signUp();
      const campaign = await h.createCampaign(gm);
      const target = await seedTarget(campaign, gm.id, withHp(1));
      const path = 'resources.hp.current';
      const spend: readonly PlannedOperation[] = [
        { operation: { op: 'delta', path, value: -1 }, requires: { path, atLeast: 1 } },
      ];
      const first = application(gm, campaign, target, spend);
      const second = application(gm, campaign, target, spend);
      expect(await h.send(gm, first)).toMatchObject({ status: 'accepted' });
      expect(await h.send(gm, second)).toEqual(
        expect.objectContaining({ status: 'error', code: 'target_changed', retryable: false }),
      );
      expect(await hpOf(target)).toBe(0);
      expect(await rowCount(second.id)).toBe(0);
    } finally {
      await h.app.close();
    }
  }, 60_000);

  test('all effects apply or none do', async () => {
    const h = await runtime();
    try {
      const gm = await h.signUp();
      const campaign = await h.createCampaign(gm);
      const target = await seedTarget(campaign, gm.id, withHp(10));

      // A later operation refused: the earlier delta does not survive.
      const refused = application(gm, campaign, target, [
        ...hpDelta(-3),
        {
          operation: { op: 'set', path: 'fields.a', value: 1 },
          requires: { path: 'conditions.never', atLeast: 5 },
        },
      ]);
      expect((await h.send(gm, refused)).code).toBe('target_changed');
      expect(await hpOf(target)).toBe(10);
      expect(await rowCount(refused.id)).toBe(0);

      // A fault writing the target: retryable, nothing written, and the retry applies once.
      const faulted = application(gm, campaign, target, hpDelta(-2));
      FAULT.armed = true;
      const mutationId = crypto.randomUUID();
      const failed = await h.send(gm, faulted, { mutationId });
      FAULT.armed = false;
      expect(failed).toEqual(
        expect.objectContaining({
          status: 'error',
          code: 'authority_unavailable',
          retryable: true,
        }),
      );
      expect(await rowCount(faulted.id)).toBe(0);
      expect(await hpOf(target)).toBe(10);
      expect(await h.send(gm, faulted, { mutationId })).toMatchObject({ status: 'accepted' });
      expect(await hpOf(target)).toBe(8);
    } finally {
      FAULT.armed = false;
      await h.app.close();
    }
  }, 60_000);

  test('who may apply is decided by feature 04, on the target', async () => {
    const h = await runtime();
    try {
      const owner = await h.signUp();
      const assistant = await h.signUp();
      const playerA = await h.signUp();
      const playerB = await h.signUp();
      const leaver = await h.signUp();
      const stranger = await h.signUp();
      const campaign = await h.createCampaign(owner);
      await h.invite(owner, campaign, assistant, 'assistant_gm');
      await h.invite(owner, campaign, playerA, 'player');
      await h.invite(owner, campaign, playerB, 'player');
      await h.invite(owner, campaign, leaver, 'player');
      const hidden = 'not_found_or_forbidden';

      // `campaign_entity`: GM roles update, players read only.
      const shared = await seedTarget(campaign, owner.id, withHp(10));
      for (const who of [owner, assistant]) {
        const record = application(who, campaign, shared, hpDelta(-1));
        expect(await h.send(who, record)).toMatchObject({ status: 'accepted' });
      }
      const denied = application(playerA, campaign, shared, hpDelta(-1));
      expect((await h.send(playerA, denied)).code).toBe(hidden);
      expect(await hpOf(shared)).toBe(8);
      expect(await rowCount(denied.id)).toBe(0);

      // `personal_note`: an Ownership Rule. The author may; another player, and a GM role, may not.
      const mine = await seedTarget(campaign, playerA.id, withHp(10), {
        mode: 'players',
        playerIds: [playerA.id],
      });
      const asNote = { targetClass: 'personal_note' };
      expect(
        await h.send(playerA, application(playerA, campaign, mine, hpDelta(-1), asNote)),
      ).toMatchObject({ status: 'accepted' });
      for (const who of [playerB, owner]) {
        expect(
          (await h.send(who, application(who, campaign, mine, hpDelta(-1), asNote))).code,
        ).toBe(hidden);
      }
      expect(await hpOf(mine)).toBe(9);

      // A missing target answers the same as a forbidden one.
      const missing = application(owner, campaign, crypto.randomUUID(), hpDelta(-1));
      expect((await h.send(owner, missing)).code).toBe(hidden);

      // The owner's denied path refuses the whole application.
      const locked = application(owner, campaign, shared, [
        { operation: { op: 'set', path: 'fields.locked', value: 1 } },
      ]);
      expect((await h.send(owner, locked)).code).toBe(hidden);

      // Another class with no adapter is loud, not silent.
      const unknown = application(owner, campaign, shared, hpDelta(-1), {
        targetClass: 'something_else',
      });
      expect((await h.send(owner, unknown)).code).toBe('unknown_target');

      // A former member and a stranger.
      await h.app.inject({
        method: 'DELETE',
        url: `/campaigns/${campaign}/members/${leaver.id}`,
        headers: owner.headers,
      });
      for (const who of [leaver, stranger]) {
        const record = application(who, campaign, shared, hpDelta(-1));
        expect((await h.send(who, record)).status).toBe('error');
        expect(await rowCount(record.id)).toBe(0);
      }
      expect(await hpOf(shared)).toBe(8);
    } finally {
      await h.app.close();
    }
  }, 60_000);

  test('editing a plan by hand needs the override capability', async () => {
    const h = await runtime();
    try {
      const owner = await h.signUp();
      const player = await h.signUp();
      const campaign = await h.createCampaign(owner);
      await h.invite(owner, campaign, player, 'player');
      const mine = await seedTarget(campaign, player.id, withHp(10), {
        mode: 'players',
        playerIds: [player.id],
      });
      const edited = { targetClass: 'personal_note', edited: true };
      const refused = application(player, campaign, mine, hpDelta(-1), edited);
      expect((await h.send(player, refused)).code).toBe('not_found_or_forbidden');
      expect(await hpOf(mine)).toBe(10);
      const shared = await seedTarget(campaign, owner.id, withHp(10));
      const accepted = application(owner, campaign, shared, hpDelta(-4), { edited: true });
      expect(await h.send(owner, accepted)).toMatchObject({ status: 'accepted' });
      const [row] = await db<{ edited: boolean }[]>`
        select edited from effect_applications where id = ${accepted.id}`;
      expect(row?.edited).toBe(true);
    } finally {
      await h.app.close();
    }
  }, 60_000);

  test('the authority fills the record, audits once in the transaction, and bounds apply', async () => {
    const h = await runtime();
    try {
      const gm = await h.signUp();
      const campaign = await h.createCampaign(gm);
      const target = await seedTarget(campaign, gm.id, withHp(10));
      const record = application(gm, campaign, target, hpDelta(-3), { action: 'hit' });
      expect(await h.send(gm, record)).toMatchObject({ status: 'accepted' });
      const [row] = await db<Record<string, unknown>[]>`
        select * from effect_applications where id = ${record.id}`;
      expect(row).toMatchObject({
        actor_user_id: gm.id,
        target_class: 'campaign_entity',
        target_id: target,
        action: 'hit',
        visibility_mode: 'everyone',
        changes: [{ path: 'resources.hp.current', before: 10, after: 7 }],
      });
      const events = await db<{ action: string; before_value: unknown; after_value: unknown }[]>`
        select action, before_value, after_value from audit_campaign_events
        where target_id = ${record.id}`;
      expect([...events]).toEqual([
        {
          action: 'effect.applied',
          before_value: { changes: [{ path: 'resources.hp.current', value: 10 }] },
          after_value: { changes: [{ path: 'resources.hp.current', value: 7 }] },
        },
      ]);
      // A retry and a resend under a new mutation add nothing.
      await h.send(gm, record);
      await h.send(gm, record);
      const [{ count } = { count: -1 }] = await db<{ count: number }[]>`
        select count(*)::int as count from audit_campaign_events where target_id = ${record.id}`;
      expect(count).toBe(1);

      // The owner's declared bounds hold whatever a device sends (D-14).
      const huge = application(gm, campaign, target, [
        { operation: { op: 'delta', path: 'resources.hp.current', value: 5000 } },
      ]);
      expect(await h.send(gm, huge)).toMatchObject({ status: 'accepted' });
      expect(await hpOf(target)).toBe(99);
    } finally {
      await h.app.close();
    }
  }, 60_000);

  test('a record is never wider than its target: zero on a player replica', async () => {
    const h = await runtime();
    try {
      const owner = await h.signUp();
      const playerA = await h.signUp();
      const playerB = await h.signUp();
      const campaign = await h.createCampaign(owner);
      await h.invite(owner, campaign, playerA, 'player');
      await h.invite(owner, campaign, playerB, 'player');
      const query = await effectsQuery();
      const received = async (who: Who) =>
        (await db.unsafe<{ id: string }[]>(query, [who.id])).map((row) => row.id).sort();

      const shared = await seedTarget(campaign, owner.id, withHp(10));
      const secret = await seedTarget(campaign, owner.id, withHp(10), { mode: 'gm_only' });
      const forA = await seedTarget(campaign, owner.id, withHp(10), {
        mode: 'players',
        playerIds: [playerA.id],
      });
      const onShared = application(owner, campaign, shared, hpDelta(-1));
      // The device claims `everyone` on every record: the authority's answer is the target's.
      const onSecret = application(owner, campaign, secret, hpDelta(-1));
      const onForA = application(owner, campaign, forA, hpDelta(-1));
      const onHiddenPath = application(owner, campaign, shared, [
        { operation: { op: 'delta', path: `${HIDDEN_PREFIX}current`, value: 1 } },
      ]);
      for (const record of [onShared, onSecret, onForA, onHiddenPath]) {
        expect(await h.send(owner, record)).toMatchObject({ status: 'accepted' });
      }
      expect(await received(owner)).toEqual(
        [onShared.id, onSecret.id, onForA.id, onHiddenPath.id].sort(),
      );
      expect(await received(playerA)).toEqual([onShared.id, onForA.id].sort());
      expect(await received(playerB)).toEqual([onShared.id]);
      for (const player of [playerA, playerB]) {
        const payload = JSON.stringify(await db.unsafe(query, [player.id]));
        expect(payload).not.toContain(onSecret.id);
        expect(payload).not.toContain(onHiddenPath.id);
        expect(payload).not.toContain(HIDDEN_PREFIX);
      }
    } finally {
      await h.app.close();
    }
  }, 60_000);

  test('the authority refuses malformed writes, terminally', async () => {
    const h = await runtime();
    try {
      const owner = await h.signUp();
      const member = await h.signUp();
      const campaign = await h.createCampaign(owner);
      await h.invite(owner, campaign, member, 'player');
      const target = await seedTarget(campaign, owner.id, withHp(10));
      const faithful = () => application(owner, campaign, target, hpDelta(-1));
      const invalid = expect.objectContaining({
        status: 'error',
        code: 'invalid_effect',
        retryable: false,
      });
      const hostile: readonly unknown[] = [
        { ...faithful(), actorUserId: member.id, createdBy: member.id, updatedBy: member.id },
        {
          ...faithful(),
          operations: [{ operation: { op: 'set', path: 'fields.__proto__', value: 1 } }],
        },
        { ...faithful(), changes: [{ path: 'fields.a', before: 1, after: 2 }] },
        { ...faithful(), acceptedAt: '2026-11-01T12:00:00.000Z' },
        { ...faithful(), version: 2 },
        { ...faithful(), operations: [] },
        { ...faithful(), action: 'a\u0000b' },
        { ...faithful(), extra: true },
      ];
      for (const record of hostile) {
        const { id } = record as { id: string };
        expect(await h.upload(owner, campaign, id, record)).toEqual(invalid);
        expect(await rowCount(id)).toBe(0);
      }
      expect(await hpOf(target)).toBe(10);

      const record = faithful();
      const refused = expect.objectContaining({ status: 'error', code: 'invalid_payload' });
      expect(await h.send(owner, record, { audit: true })).toEqual(refused);
      expect(await h.upload(owner, campaign, crypto.randomUUID(), record)).toEqual(refused);
      expect(await h.send(owner, record)).toMatchObject({ status: 'accepted' });
      expect(await h.send(owner, record, { operation: 'update', expectedVersion: 1 })).toEqual(
        refused,
      );
      expect(await h.send(owner, record, { operation: 'tombstone', expectedVersion: 1 })).toEqual(
        refused,
      );
      expect(await rowCount(record.id)).toBe(1);
    } finally {
      await h.app.close();
    }
  }, 60_000);

  test('with no adapter registered, an application is refused loudly', async () => {
    if (databaseUrl === undefined) throw new Error('database unavailable');
    const h = await runtime();
    const bare = buildRuntimeApp({
      databaseUrl,
      allowedOrigin: origin,
      production: false,
      powerSyncEndpoint: 'http://localhost:8080',
      powerSyncJwtSecret: 'ZGV2ZWxvcG1lbnQtb25seS1wb3dlcnN5bmMta2V5LTMyIQ',
      systems: [FIXTURE_SYSTEM_DEFINITION],
      logger: false,
    });
    try {
      await bare.ready();
      const gm = await h.signUp();
      const campaign = await h.createCampaign(gm);
      const target = await seedTarget(campaign, gm.id, withHp(10));
      const record = application(gm, campaign, target, hpDelta(-1));
      const at = new Date().toISOString();
      const response = await bare.inject({
        method: 'POST',
        url: '/sync/mutations',
        headers: gm.headers,
        payload: {
          campaignId: campaign,
          replicaId: crypto.randomUUID(),
          mutations: [
            {
              mutationId: crypto.randomUUID(),
              campaignId: campaign,
              featureId: ACTIONS_SYNC_FEATURE_ID,
              tableName: EFFECT_REPLICA_TABLE,
              recordId: record.id,
              operation: 'insert',
              expectedVersion: null,
              payload: record,
              causalSequence: 1,
              state: 'pending',
              attemptCount: 0,
              recordedAt: at,
            },
          ],
        },
      });
      expect((response.json() as { outcomes: { code?: string }[] }).outcomes[0]?.code).toBe(
        'unknown_target',
      );
      expect(await rowCount(record.id)).toBe(0);
    } finally {
      await bare.close();
      await h.app.close();
    }
  }, 60_000);

  test('the probe adapter passes the contract features 15 and 19 will run', async () => {
    if (databaseUrl === undefined) throw new Error('database unavailable');
    const connection = connectActionsDatabase(databaseUrl);
    const repository = new PostgresEffectRepository(connection.db);
    const campaign = crypto.randomUUID();
    const owner = crypto.randomUUID();
    const target = await seedTarget(campaign, owner, EMPTY);
    class Rollback extends Error {}
    try {
      await repository.transaction(async (transaction) => {
        expect(
          await runEffectTargetContract({
            adapter: probeAdapter('campaign_entity'),
            transaction,
            campaignId: campaign,
            targetId: target,
            otherCampaignId: crypto.randomUUID(),
            actorUserId: owner,
          }),
        ).toEqual([]);
        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    } finally {
      await connection.close();
    }
  }, 60_000);
});
