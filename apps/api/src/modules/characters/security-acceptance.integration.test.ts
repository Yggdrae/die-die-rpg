import { afterAll, describe, expect, test } from 'bun:test';
import {
  ACTIONS_SYNC_FEATURE_ID,
  EFFECT_RECORD_TYPE,
  EFFECT_REPLICA_TABLE,
  type EffectRecord,
  type PlannedOperation,
} from '@rpg/actions';
import {
  CHARACTER_RECORD_TYPE,
  CHARACTER_REPLICA_TABLE,
  CHARACTERS_SYNC_FEATURE_ID,
  type CharacterRecord,
  characterVisibility,
  editPlan,
  initialCharacterState,
  type SheetEdit,
  splitState,
} from '@rpg/characters';
import type { Role } from '@rpg/contracts';
import { FIXTURE_SYSTEM_DEFINITION, FIXTURE_SYSTEM_PACKAGE } from '@rpg/fixtures';
import type { SystemPackage } from '@rpg/systems';
import postgres from 'postgres';
import { buildRuntimeApp } from '../../runtime.ts';

/**
 * Feature 15 acceptance on PostgreSQL through the real composition root: characters are created and deleted
 * through their own mutations, and every edit is a feature 11 application on class `character`. Then the
 * configured `authorized_characters` and `authorized_effects` queries (verbatim, requester as `$1`) run for
 * every requester. Character, application, and receipt rows are deleted afterwards.
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
    await sql`select 1 from characters, character_secrets limit 1`;
    return true;
  } catch {
    return false;
  }
})();
const campaigns: string[] = [];
const SYSTEM = FIXTURE_SYSTEM_PACKAGE as SystemPackage;

afterAll(async () => {
  if (available && campaigns.length > 0) {
    await db`delete from effect_applications where campaign_id = any(${campaigns}::uuid[])`;
    await db`delete from character_secrets where campaign_id = any(${campaigns}::uuid[])`;
    await db`delete from characters where campaign_id = any(${campaigns}::uuid[])`;
    await db`delete from sync_mutation_receipts where campaign_id = any(${campaigns}::uuid[])`;
  }
  await sql?.end({ timeout: 1 });
});

const SYNC_CONFIG = new URL('../../../../../infra/powersync/sync-config.yaml', import.meta.url);

async function queryOf(table: string): Promise<string> {
  const parsed = Bun.YAML.parse(await Bun.file(SYNC_CONFIG).text()) as {
    readonly streams: Record<string, { readonly queries?: string[] }>;
  };
  const query = Object.values(parsed.streams)
    .flatMap((stream) => stream.queries ?? [])
    .find((item) => new RegExp(`FROM ${table}\\b`).test(item));
  if (query === undefined) throw new Error(`no query for ${table}`);
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
  });
  await app.ready();
  const suffix = crypto.randomUUID().slice(0, 8);
  let counter = 0;
  const signUp = async (): Promise<Who> => {
    counter += 1;
    const account = await app.inject({
      method: 'POST',
      url: '/auth/accounts',
      payload: { username: `ch_${suffix}_${counter}`, password: 'correct horse battery staple' },
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
        name: 'Sheet acceptance',
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
    mutation: {
      readonly featureId: string;
      readonly tableName: string;
      readonly recordId: string;
      readonly operation: 'insert' | 'update' | 'tombstone';
      readonly expectedVersion: number | null;
      readonly payload: unknown;
    },
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
            mutationId: crypto.randomUUID(),
            campaignId,
            ...mutation,
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
    };
  };
  const create = async (who: Who, campaignId: string, name = 'Ash') => {
    const at = new Date().toISOString();
    const record: CharacterRecord = {
      id: crypto.randomUUID(),
      campaignId,
      type: CHARACTER_RECORD_TYPE,
      name,
      tags: [],
      metadata: {},
      visibility: characterVisibility(who.id),
      version: 1,
      createdAt: at,
      createdBy: who.id,
      updatedAt: at,
      updatedBy: who.id,
      ownerUserId: who.id,
      system: SYSTEM.manifest.ref,
      state: splitState(SYSTEM, initialCharacterState(SYSTEM, name)).visible,
    };
    const outcome = await upload(who, campaignId, {
      featureId: CHARACTERS_SYNC_FEATURE_ID,
      tableName: CHARACTER_REPLICA_TABLE,
      recordId: record.id,
      operation: 'insert',
      expectedVersion: null,
      payload: record,
    });
    return { record, outcome };
  };
  const apply = async (
    who: Who,
    campaignId: string,
    characterId: string,
    operations: readonly PlannedOperation[],
  ) => {
    const at = new Date().toISOString();
    const record: EffectRecord = {
      id: crypto.randomUUID(),
      campaignId,
      type: EFFECT_RECORD_TYPE,
      name: 'edit',
      tags: [],
      metadata: {},
      visibility: { mode: 'everyone' },
      version: 1,
      createdAt: at,
      createdBy: who.id,
      updatedAt: at,
      updatedBy: who.id,
      actorUserId: who.id,
      targetClass: 'character',
      targetId: characterId,
      operations,
      changes: [],
      edited: false,
      appliedAt: at,
    };
    const outcome = await upload(who, campaignId, {
      featureId: ACTIONS_SYNC_FEATURE_ID,
      tableName: EFFECT_REPLICA_TABLE,
      recordId: record.id,
      operation: 'insert',
      expectedVersion: null,
      payload: record,
    });
    return { record, outcome };
  };
  const planned = (change: SheetEdit, gm = false, state = initialCharacterState(SYSTEM, 'Ash')) => {
    const plan = editPlan(SYSTEM, state, change, gm);
    if (!plan.ok) throw new Error(plan.error);
    return plan.value.operations;
  };
  return { app, signUp, createCampaign, invite, upload, create, apply, planned };
}

async function stateOf(id: string) {
  const [row] = await db<{ state: Record<string, Record<string, unknown>>; version: number }[]>`
    select state, version from characters where id = ${id}`;
  const [secret] = await db<{ state: Record<string, Record<string, unknown>> }[]>`
    select state from character_secrets where id = ${id}`;
  return { state: row?.state, version: row?.version, secret: secret?.state };
}

describe.skipIf(!available)('feature 15 acceptance', () => {
  test('a member creates a pinned character from the defaults; nothing else is accepted', async () => {
    const h = await runtime();
    try {
      const owner = await h.signUp();
      const campaign = await h.createCampaign(owner);
      const created = await h.create(owner, campaign);
      expect(created.outcome).toMatchObject({ status: 'accepted' });
      const stored = await stateOf(created.record.id);
      expect(stored.state?.fields?.name).toBe('Ash');
      expect(Object.hasOwn(stored.state?.fields ?? {}, 'gmNote')).toBe(false);
      expect(stored.secret?.fields).toEqual({ gmNote: '' });
      const events = await db<{ action: string }[]>`
        select action from audit_campaign_events where target_id = ${created.record.id}`;
      expect(events.map((event) => event.action)).toEqual(['character.created']);

      // A create smuggling values past the edit rules, or for another system, is refused.
      const smuggled = { ...created.record, id: crypto.randomUUID() };
      const tampered = {
        ...smuggled,
        state: { ...smuggled.state, fields: { ...smuggled.state.fields, VIGOR: 99 } },
      };
      expect(
        (
          await h.upload(owner, campaign, {
            featureId: CHARACTERS_SYNC_FEATURE_ID,
            tableName: CHARACTER_REPLICA_TABLE,
            recordId: tampered.id,
            operation: 'insert',
            expectedVersion: null,
            payload: tampered,
          })
        ).code,
      ).toBe('invalid_character');
      const foreign = {
        ...smuggled,
        id: crypto.randomUUID(),
        system: { systemId: 'another-system', version: '1.0.0' },
      };
      expect(
        (
          await h.upload(owner, campaign, {
            featureId: CHARACTERS_SYNC_FEATURE_ID,
            tableName: CHARACTER_REPLICA_TABLE,
            recordId: foreign.id,
            operation: 'insert',
            expectedVersion: null,
            payload: foreign,
          })
        ).code,
      ).toBe('invalid_character');
    } finally {
      await h.app.close();
    }
  }, 60_000);

  test('owners and GM roles edit; another player may not, nor see the character', async () => {
    const h = await runtime();
    try {
      const owner = await h.signUp();
      const assistant = await h.signUp();
      const playerA = await h.signUp();
      const playerB = await h.signUp();
      const campaign = await h.createCampaign(owner);
      await h.invite(owner, campaign, assistant, 'assistant_gm');
      await h.invite(owner, campaign, playerA, 'player');
      await h.invite(owner, campaign, playerB, 'player');
      const { record } = await h.create(playerA, campaign);
      const vigorUp = h.planned({ kind: 'adjust_field', field: 'VIGOR', by: 1 });
      for (const who of [playerA, assistant, owner]) {
        expect((await h.apply(who, campaign, record.id, vigorUp)).outcome).toMatchObject({
          status: 'accepted',
        });
      }
      expect((await h.apply(playerB, campaign, record.id, vigorUp)).outcome.code).toBe(
        'not_found_or_forbidden',
      );
      const query = await queryOf('characters');
      const received = async (who: Who) =>
        (await db.unsafe<{ id: string }[]>(query, [who.id])).map((row) => row.id);
      expect(await received(playerA)).toEqual([record.id]);
      expect(await received(owner)).toEqual([record.id]);
      expect(await received(playerB)).toEqual([]);
    } finally {
      await h.app.close();
    }
  }, 60_000);

  test('concurrent numeric changes merge; concurrent text edits refuse instead of overwriting', async () => {
    const h = await runtime();
    try {
      const owner = await h.signUp();
      const player = await h.signUp();
      const campaign = await h.createCampaign(owner);
      await h.invite(owner, campaign, player, 'player');
      const { record } = await h.create(player, campaign);
      const before = (await stateOf(record.id)).state?.resources?.focus as { current: number };
      const down = h.planned({ kind: 'adjust_resource', resource: 'focus', by: -2 });
      const up = h.planned({ kind: 'adjust_resource', resource: 'focus', by: 1 });
      expect((await h.apply(player, campaign, record.id, down)).outcome.status).toBe('accepted');
      expect((await h.apply(owner, campaign, record.id, up)).outcome.status).toBe('accepted');
      const after = (await stateOf(record.id)).state?.resources?.focus as { current: number };
      expect(after.current).toBe(Math.min(6, Math.max(0, before.current - 2) + 1));

      // Both devices saw the name "Ash".
      const renameA = h.planned({ kind: 'set_field', field: 'name', value: 'Bram' });
      const renameB = h.planned({ kind: 'set_field', field: 'name', value: 'Cole' });
      expect((await h.apply(player, campaign, record.id, renameA)).outcome.status).toBe('accepted');
      expect((await h.apply(owner, campaign, record.id, renameB)).outcome.code).toBe(
        'target_changed',
      );
      expect((await stateOf(record.id)).state?.fields?.name).toBe('Bram');
    } finally {
      await h.app.close();
    }
  }, 60_000);

  test('a GM-only value is written to the secret row and never reaches a player', async () => {
    const h = await runtime();
    try {
      const owner = await h.signUp();
      const player = await h.signUp();
      const campaign = await h.createCampaign(owner);
      await h.invite(owner, campaign, player, 'player');
      const { record } = await h.create(player, campaign);
      const note = h.planned({ kind: 'set_field', field: 'gmNote', value: 'Secret ally' }, true);
      // A player's crafted write to it is refused, whatever the device claimed.
      expect((await h.apply(player, campaign, record.id, note)).outcome.code).toBe(
        'not_found_or_forbidden',
      );
      const written = await h.apply(owner, campaign, record.id, note);
      expect(written.outcome.status).toBe('accepted');
      const stored = await stateOf(record.id);
      expect(stored.secret?.fields?.gmNote).toBe('Secret ally');
      expect(JSON.stringify(stored.state)).not.toContain('Secret ally');

      const secrets = await queryOf('character_secrets');
      const effects = await queryOf('effect_applications');
      expect(
        (await db.unsafe<{ id: string }[]>(secrets, [owner.id])).map((row) => row.id),
      ).toContain(record.id);
      for (const query of [secrets, effects]) {
        const payload = JSON.stringify(await db.unsafe(query, [player.id]));
        expect(payload).not.toContain('Secret ally');
      }
      expect(JSON.stringify(await db.unsafe(effects, [player.id]))).not.toContain(
        written.record.id,
      );
      const players = JSON.stringify(await db.unsafe(await queryOf('characters'), [player.id]));
      expect(players).not.toContain('Secret ally');
    } finally {
      await h.app.close();
    }
  }, 60_000);

  test('the schema bounds every value at the authority', async () => {
    const h = await runtime();
    try {
      const owner = await h.signUp();
      const campaign = await h.createCampaign(owner);
      const { record } = await h.create(owner, campaign);
      const hostile: readonly PlannedOperation[][] = [
        [{ operation: { op: 'set', path: 'fields.undeclared', value: 1 } }],
        [{ operation: { op: 'set', path: 'resources.nope.current', value: 1 } }],
        [{ operation: { op: 'set', path: 'entries.bonds.x.undeclared', value: 1 } }],
      ];
      for (const operations of hostile) {
        expect((await h.apply(owner, campaign, record.id, operations)).outcome.code).toBe(
          'not_found_or_forbidden',
        );
      }
      // A device sending a number past its bounds is clamped by the pinned package.
      const huge = await h.apply(owner, campaign, record.id, [
        { operation: { op: 'delta', path: 'resources.focus.current', value: 500 } },
      ]);
      expect(huge.outcome.status).toBe('accepted');
      expect(
        ((await stateOf(record.id)).state?.resources?.focus as { current: number } | undefined)
          ?.current,
      ).toBe(6);
    } finally {
      await h.app.close();
    }
  }, 60_000);

  test('owners and GM roles delete; another player may not', async () => {
    const h = await runtime();
    try {
      const owner = await h.signUp();
      const playerA = await h.signUp();
      const playerB = await h.signUp();
      const campaign = await h.createCampaign(owner);
      await h.invite(owner, campaign, playerA, 'player');
      await h.invite(owner, campaign, playerB, 'player');
      const { record } = await h.create(playerA, campaign);
      const remove = (who: Who, version: number) =>
        h.upload(who, campaign, {
          featureId: CHARACTERS_SYNC_FEATURE_ID,
          tableName: CHARACTER_REPLICA_TABLE,
          recordId: record.id,
          operation: 'tombstone',
          expectedVersion: version,
          payload: { id: record.id },
        });
      expect((await remove(playerB, 1)).code).toBe('not_found_or_forbidden');
      expect((await remove(playerA, 9)).status).toBe('conflict');
      expect((await remove(playerA, 1)).status).toBe('accepted');
      const [row] = await db<{ deleted_at: Date | null }[]>`
        select deleted_at from characters where id = ${record.id}`;
      expect(row?.deleted_at).not.toBeNull();
      const events = await db<{ action: string }[]>`
        select action from audit_campaign_events where target_id = ${record.id} order by accepted_at`;
      expect(events.map((event) => event.action)).toEqual([
        'character.created',
        'character.deleted',
      ]);
    } finally {
      await h.app.close();
    }
  }, 60_000);
});
