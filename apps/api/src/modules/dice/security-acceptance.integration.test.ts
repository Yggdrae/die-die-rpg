import { afterAll, describe, expect, test } from 'bun:test';
import type { Role } from '@rpg/contracts';
import {
  DICE_ROLL_REPLICA_TABLE,
  DICE_SYNC_FEATURE_ID,
  evaluateRoll,
  parseRoll,
  ROLL_RECORD_TYPE,
  type RollRecord,
  type RollVisibility,
  rollDisplayName,
  rollVisibilityToVisibility,
  seededRandom,
} from '@rpg/dice';
import { FIXTURE_SYSTEM_DEFINITION } from '@rpg/fixtures';
import postgres from 'postgres';
import { buildRuntimeApp } from '../../runtime.ts';

/**
 * Feature 09 security acceptance on PostgreSQL through the real composition root. Rolls are written only
 * through `POST /sync/mutations`; then the configured `authorized_rolls` query
 * (`infra/powersync/sync-config.yaml`, verbatim, requester bound as `$1`) runs against the real table
 * for every requester and must return exactly the rows the visibility rules allow: owner, gm,
 * assistant_gm, player A, player B, removed gm, non-member, and the owner of another campaign. The live
 * PowerSync counterpart is in `sync-config.powersync.integration.test.ts`, and the browser one in
 * `apps/web/e2e/dice.e2e.ts`. Roll and receipt rows are deleted; users and campaigns stay, as in earlier
 * suites.
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
    await sql`select 1 from dice_rolls limit 1`;
    return true;
  } catch {
    return false;
  }
})();
const campaigns: string[] = [];

afterAll(async () => {
  if (available && campaigns.length > 0) {
    await db`delete from dice_rolls where campaign_id = any(${campaigns}::uuid[])`;
    await db`delete from sync_mutation_receipts where campaign_id = any(${campaigns}::uuid[])`;
  }
  await sql?.end({ timeout: 1 });
});

const SYNC_CONFIG = new URL('../../../../../infra/powersync/sync-config.yaml', import.meta.url);

async function rollsQuery(): Promise<string> {
  const parsed = Bun.YAML.parse(await Bun.file(SYNC_CONFIG).text()) as {
    readonly streams: Record<string, { readonly queries?: string[] }>;
  };
  const query = parsed.streams.authorized_rolls?.queries?.[0];
  if (query === undefined) throw new Error('no rolls stream');
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

function rollRecord(
  who: Who,
  campaignId: string,
  visibility: RollVisibility,
  overrides: Partial<RollRecord> & { readonly recipients?: readonly string[] } = {},
): RollRecord {
  const { recipients, ...rest } = overrides;
  const expression = rest.expression ?? '2d6+3';
  const inputs = rest.inputs ?? {};
  const parsed = parseRoll(expression);
  if (!parsed.ok) throw new Error('parse');
  const result = evaluateRoll(parsed.value, inputs, seededRandom(17));
  if (!result.ok) throw new Error('evaluate');
  const mapped = rollVisibilityToVisibility(visibility, who.id, recipients);
  if (typeof mapped === 'string') throw new Error(mapped);
  const at = '2026-10-31T12:00:00.000Z';
  return {
    id: crypto.randomUUID(),
    campaignId,
    type: ROLL_RECORD_TYPE,
    name: rollDisplayName(rest.action, expression),
    tags: [],
    metadata: {},
    visibility: mapped,
    version: 1,
    createdAt: at,
    createdBy: who.id,
    updatedAt: at,
    updatedBy: who.id,
    actorUserId: who.id,
    expression,
    inputs,
    result: result.value,
    rollVisibility: visibility,
    rolledAt: at,
    ...rest,
  };
}

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
      payload: { username: `dice_${suffix}_${counter}`, password: 'correct horse battery staple' },
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
        name: 'Dice acceptance',
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
            featureId: DICE_SYNC_FEATURE_ID,
            tableName: DICE_ROLL_REPLICA_TABLE,
            recordId,
            operation: options.operation ?? 'insert',
            expectedVersion: options.expectedVersion ?? null,
            payload,
            ...(options.audit === true
              ? {
                  audit: {
                    campaignId,
                    action: 'dice.created',
                    targetType: DICE_ROLL_REPLICA_TABLE,
                    targetId: recordId,
                    at,
                    private: false,
                  },
                }
              : {}),
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
    };
  };
  const send = (who: Who, record: RollRecord) => upload(who, record.campaignId, record.id, record);
  return { app, signUp, createCampaign, invite, upload, send };
}

async function rowCount(id: string): Promise<number> {
  const [row] = await db<{ count: number }[]>`
    select count(*)::int as count from dice_rolls where id = ${id}`;
  return row?.count ?? 0;
}

describe.skipIf(!available)('feature 09 security acceptance', () => {
  test('every requester receives exactly the rolls the visibility rules allow', async () => {
    const h = await runtime();
    try {
      const owner = await h.signUp();
      const gm = await h.signUp();
      const assistant = await h.signUp();
      const playerA = await h.signUp();
      const playerB = await h.signUp();
      const removedGm = await h.signUp();
      const nonMember = await h.signUp();
      const foreignOwner = await h.signUp();
      const campaign = await h.createCampaign(owner);
      await h.createCampaign(foreignOwner);
      await h.invite(owner, campaign, gm, 'gm');
      await h.invite(owner, campaign, assistant, 'assistant_gm');
      await h.invite(owner, campaign, playerA, 'player');
      await h.invite(owner, campaign, playerB, 'player');
      await h.invite(owner, campaign, removedGm, 'gm');

      const write = async (who: Who, visibility: RollVisibility, recipients?: string[]) => {
        const record = rollRecord(
          who,
          campaign,
          visibility,
          recipients === undefined ? {} : { recipients },
        );
        expect(await h.send(who, record)).toMatchObject({ status: 'accepted' });
        return record.id;
      };
      const gmPublic = await write(gm, 'public');
      const gmHidden = await write(gm, 'gm_only');
      const gmBlind = await write(gm, 'blind');
      const assistantHidden = await write(assistant, 'gm_only');
      const ownerBlind = await write(owner, 'blind');
      const gmPrivate = await write(gm, 'player_only');
      const gmWhisperA = await write(gm, 'whisper', [playerA.id]);
      const aPublic = await write(playerA, 'public');
      const aPrivate = await write(playerA, 'player_only');
      const aWhisperB = await write(playerA, 'whisper', [playerB.id]);
      const bPrivate = await write(playerB, 'player_only');
      const removedWrote = await write(removedGm, 'gm_only');
      const removed = await h.app.inject({
        method: 'DELETE',
        url: `/campaigns/${campaign}/members/${removedGm.id}`,
        headers: owner.headers,
      });
      expect(removed.statusCode).toBeLessThan(300);

      const every = [
        gmPublic,
        gmHidden,
        gmBlind,
        assistantHidden,
        ownerBlind,
        gmPrivate,
        gmWhisperA,
        aPublic,
        aPrivate,
        aWhisperB,
        bPrivate,
        removedWrote,
      ];
      const query = await rollsQuery();
      const received = async (who: Who) =>
        (await db.unsafe<{ id: string }[]>(query, [who.id])).map((row) => row.id).sort();

      for (const gmRole of [owner, gm, assistant]) {
        expect(await received(gmRole)).toEqual([...every].sort());
      }
      expect(await received(playerA)).toEqual(
        [gmPublic, gmWhisperA, aPublic, aPrivate, aWhisperB].sort(),
      );
      expect(await received(playerB)).toEqual([gmPublic, aPublic, aWhisperB, bPrivate].sort());
      expect(await received(removedGm)).toEqual([]);
      expect(await received(nonMember)).toEqual([]);
      expect(await received(foreignOwner)).toEqual([]);

      // Zero hidden rolls on a player replica, asserted on what the stream returns, by value.
      for (const player of [playerA, playerB]) {
        const rows = await db.unsafe<{ roll_visibility: string; visibility_mode: string }[]>(
          query,
          [player.id],
        );
        expect(rows.filter((row) => ['gm_only', 'blind'].includes(row.roll_visibility))).toEqual(
          [],
        );
        expect(rows.filter((row) => row.visibility_mode === 'gm_only')).toEqual([]);
      }
    } finally {
      await h.app.close();
    }
  }, 60_000);

  test('hidden writes change nothing a player receives', async () => {
    const h = await runtime();
    try {
      const owner = await h.signUp();
      const player = await h.signUp();
      const campaign = await h.createCampaign(owner);
      await h.invite(owner, campaign, player, 'player');
      const shared = rollRecord(owner, campaign, 'public');
      expect(await h.send(owner, shared)).toMatchObject({ status: 'accepted' });
      const query = await rollsQuery();
      const payload = async () =>
        JSON.stringify(await db.unsafe<Record<string, unknown>[]>(query, [player.id]));
      const before = await payload();
      for (let index = 0; index < 25; index += 1) {
        const hidden = rollRecord(owner, campaign, index % 2 === 0 ? 'gm_only' : 'blind');
        expect(await h.send(owner, hidden)).toMatchObject({ status: 'accepted' });
      }
      expect(await payload()).toBe(before);
    } finally {
      await h.app.close();
    }
  }, 60_000);

  test('a roll is recorded exactly once', async () => {
    const h = await runtime();
    try {
      const owner = await h.signUp();
      const campaign = await h.createCampaign(owner);
      const record = rollRecord(owner, campaign, 'public', { action: 'attack' });
      const mutationId = crypto.randomUUID();

      const first = await h.upload(owner, campaign, record.id, record, { mutationId });
      expect(first).toMatchObject({ status: 'accepted', acceptedVersion: 1 });
      // A lost acknowledgement: same mutation again.
      const retried = await h.upload(owner, campaign, record.id, record, { mutationId });
      expect(retried).toEqual(first);
      // The queue was rebuilt: same roll, new mutation.
      const resent = await h.upload(owner, campaign, record.id, record);
      expect(resent).toMatchObject({ status: 'accepted', acceptedVersion: 1 });
      expect(await rowCount(record.id)).toBe(1);

      // A different roll claiming that identity is refused and changes nothing.
      const other = rollRecord(owner, campaign, 'public', {
        id: record.id,
        expression: '1d20',
      });
      expect(await h.send(owner, other)).toEqual(
        expect.objectContaining({ status: 'error', code: 'not_found_or_forbidden' }),
      );
      const [stored] = await db<{ expression: string }[]>`
        select expression from dice_rolls where id = ${record.id}`;
      expect(stored?.expression).toBe(record.expression);
      expect(await rowCount(record.id)).toBe(1);

      // The same identity from another campaign cannot be told from any other refusal.
      const elsewhere = await h.createCampaign(owner);
      const collision = rollRecord(owner, elsewhere, 'public', { id: record.id });
      expect(await h.send(owner, collision)).toEqual(
        expect.objectContaining({ status: 'error', code: 'not_found_or_forbidden' }),
      );
    } finally {
      await h.app.close();
    }
  }, 60_000);

  test('a record stores its context, and a roll writes no audit event', async () => {
    const h = await runtime();
    try {
      const owner = await h.signUp();
      const campaign = await h.createCampaign(owner);
      const session = crypto.randomUUID();
      const record = rollRecord(owner, campaign, 'blind', {
        expression: '1d20+ATTRIBUTE_A',
        inputs: { ATTRIBUTE_A: 2 },
        actorRef: 'character-1',
        targetRef: 'goblin-1',
        action: 'attack',
        name: 'attack',
        sessionId: session,
      });
      expect(await h.send(owner, record)).toMatchObject({ status: 'accepted' });
      const [row] = await db<Record<string, unknown>[]>`
        select * from dice_rolls where id = ${record.id}`;
      expect(row).toMatchObject({
        campaign_id: campaign,
        actor_user_id: owner.id,
        actor_ref: 'character-1',
        target_ref: 'goblin-1',
        action: 'attack',
        session_id: session,
        expression: '1d20+ATTRIBUTE_A',
        roll_visibility: 'blind',
        visibility_mode: 'gm_only',
        visibility_targets: [],
        natural_result: record.result.natural,
        modified_result: record.result.modified,
        inputs: { ATTRIBUTE_A: 2 },
        result: record.result,
      });
      expect(row?.rolled_at).toEqual(new Date(record.rolledAt));
      const audit = await db<{ count: number }[]>`
        select (select count(*) from audit_campaign_events where target_id = ${record.id})::int
          + (select count(*) from audit_private_events where target_id = ${record.id})::int
          as count`;
      expect(audit[0]?.count).toBe(0);
    } finally {
      await h.app.close();
    }
  }, 60_000);

  test('a player cannot create a roll hidden from themself, nor an observer anything', async () => {
    const h = await runtime();
    try {
      const owner = await h.signUp();
      const player = await h.signUp();
      const campaign = await h.createCampaign(owner);
      await h.invite(owner, campaign, player, 'player');
      for (const visibility of ['gm_only', 'blind'] as const) {
        const record = rollRecord(player, campaign, visibility);
        expect(await h.send(player, record)).toEqual(
          expect.objectContaining({
            status: 'error',
            code: 'not_found_or_forbidden',
            retryable: false,
          }),
        );
        expect(await rowCount(record.id)).toBe(0);
      }
      // A non-member gets the platform's denial and stores nothing.
      const stranger = await h.signUp();
      const record = rollRecord(stranger, campaign, 'public');
      expect((await h.send(stranger, record)).status).toBe('error');
      expect(await rowCount(record.id)).toBe(0);
    } finally {
      await h.app.close();
    }
  }, 60_000);

  test('the authority refuses every malformed roll, terminally', async () => {
    const h = await runtime();
    try {
      const owner = await h.signUp();
      const member = await h.signUp();
      const campaign = await h.createCampaign(owner);
      await h.invite(owner, campaign, member, 'player');
      const faithful = () => rollRecord(owner, campaign, 'public');

      const cases: readonly [string, () => RollRecord | Record<string, unknown>, string][] = [
        [
          'another member as its actor',
          () => ({
            ...faithful(),
            actorUserId: member.id,
            createdBy: member.id,
            updatedBy: member.id,
          }),
          'invalid_roll',
        ],
        [
          'an expression that does not parse',
          () => ({ ...faithful(), expression: '1d7' }),
          'invalid_roll',
        ],
        [
          'a result that does not replay',
          () => {
            const record = faithful();
            return { ...record, result: { ...record.result, modified: 999 } };
          },
          'invalid_roll',
        ],
        [
          'a label against its Visibility',
          () => ({ ...faithful(), rollVisibility: 'gm_only' }),
          'invalid_roll',
        ],
        ['an unknown field', () => ({ ...faithful(), extra: true }), 'invalid_roll'],
        ['a NUL in a reference', () => ({ ...faithful(), action: 'a\u0000b' }), 'invalid_roll'],
        ['a second version', () => ({ ...faithful(), version: 2 }), 'invalid_roll'],
      ];
      for (const [name, build, code] of cases) {
        const record = build() as { id: string };
        const outcome = await h.upload(owner, campaign, record.id, record);
        expect({ name, outcome }).toEqual({
          name,
          outcome: expect.objectContaining({ status: 'error', code, retryable: false }),
        });
        expect(await rowCount(record.id)).toBe(0);
      }

      // An audit envelope, an update, a tombstone, and a mismatched id are not roll writes.
      const record = faithful();
      const invalid = expect.objectContaining({ status: 'error', code: 'invalid_payload' });
      expect(await h.upload(owner, campaign, record.id, record, { audit: true })).toEqual(invalid);
      expect(await h.upload(owner, campaign, crypto.randomUUID(), record)).toEqual(invalid);
      expect(await rowCount(record.id)).toBe(0);
      expect(await h.send(owner, record)).toMatchObject({ status: 'accepted' });
      expect(
        await h.upload(owner, campaign, record.id, record, {
          operation: 'update',
          expectedVersion: 1,
        }),
      ).toEqual(invalid);
      expect(
        await h.upload(owner, campaign, record.id, record, {
          operation: 'tombstone',
          expectedVersion: 1,
        }),
      ).toEqual(invalid);
      expect(await rowCount(record.id)).toBe(1);
    } finally {
      await h.app.close();
    }
  }, 60_000);

  test('the table itself refuses what the label and the columns disagree on', async () => {
    const user = crypto.randomUUID();
    const other = crypto.randomUUID();
    const insert = (values: {
      label: string;
      mode: string;
      targets: readonly string[];
      version?: number;
      expression?: string;
    }) =>
      db`insert into dice_rolls (id, campaign_id, actor_user_id, expression, result, natural_result,
          modified_result, roll_visibility, visibility_mode, visibility_targets, version, rolled_at)
        values (${crypto.randomUUID()}, ${crypto.randomUUID()}, ${user},
          ${values.expression ?? '1d6'}, ${db.json({ terms: [] })}, 1, 1, ${values.label},
          ${values.mode}, ${db.json([...values.targets])}, ${values.version ?? 1}, now())`;
    const sorted = [user, other].sort();
    const refused: Parameters<typeof insert>[0][] = [
      { label: 'public', mode: 'gm_only', targets: [] },
      { label: 'gm_only', mode: 'everyone', targets: [] },
      { label: 'blind', mode: 'players', targets: [user] },
      { label: 'player_only', mode: 'players', targets: [other] },
      { label: 'player_only', mode: 'players', targets: sorted },
      { label: 'whisper', mode: 'players', targets: [user] },
      { label: 'whisper', mode: 'players', targets: [other] },
      { label: 'whisper', mode: 'players', targets: [...sorted].reverse() },
      { label: 'secret', mode: 'everyone', targets: [] },
      { label: 'public', mode: 'everyone', targets: [], version: 2 },
      { label: 'public', mode: 'everyone', targets: [], expression: '' },
      { label: 'public', mode: 'everyone', targets: [], expression: 'x'.repeat(201) },
    ];
    for (const values of refused) {
      // `await expect(promise).rejects` hangs with Bun and postgres.js.
      let code: string | undefined;
      try {
        await insert(values);
      } catch (error) {
        code = (error as { code?: string }).code;
      }
      expect({ values, code }).toEqual({ values, code: '23514' });
    }
    const [{ count } = { count: -1 }] = await db<{ count: number }[]>`
      select count(*)::int as count from dice_rolls where actor_user_id = ${user}`;
    expect(count).toBe(0);
  });
});
