import { afterAll, describe, expect, test } from 'bun:test';
import type { Role } from '@rpg/contracts';
import { FIXTURE_SYSTEM_DEFINITION } from '@rpg/fixtures';
import {
  SESSION_LOG_REPLICA_TABLE,
  SESSION_NOTE_REPLICA_TABLE,
  SESSION_REPLICA_TABLE,
  SESSIONS_SYNC_FEATURE_ID,
  type SessionLogEntryRecord,
  type SessionNoteRecord,
  type SessionRecord,
} from '@rpg/sessions';
import postgres from 'postgres';
import { buildRuntimeApp } from '../../runtime.ts';

/**
 * Feature 18 on PostgreSQL through the real composition root (`_techspec.md` "Authority"): numbering and one open
 * session (D-04), transitions and conflicts (D-05), GM-only notes (D-06), entry rules (D-10), the matrix (players
 * refused), audit once per mutation (D-14), and the configured `authorized_sessions` queries returning GM notes and
 * GM-only entries to no player. The live PowerSync counterpart is in `sync-config.powersync.integration.test.ts`.
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
    await sql`select 1 from campaign_sessions, session_gm_notes, session_log_entries limit 1`;
    return true;
  } catch {
    return false;
  }
})();
const campaigns: string[] = [];

afterAll(async () => {
  if (available && campaigns.length > 0) {
    await db`delete from session_log_entries where campaign_id = any(${campaigns}::uuid[])`;
    await db`delete from session_gm_notes where campaign_id = any(${campaigns}::uuid[])`;
    await db`delete from campaign_sessions where campaign_id = any(${campaigns}::uuid[])`;
    await db`delete from sync_mutation_receipts where campaign_id = any(${campaigns}::uuid[])`;
  }
  await sql?.end({ timeout: 1 });
});

const SYNC_CONFIG = new URL('../../../../../infra/powersync/sync-config.yaml', import.meta.url);

/** One configured `authorized_sessions` query, as PostgreSQL (requester `$1`). */
async function streamQuery(table: string): Promise<string> {
  const parsed = Bun.YAML.parse(await Bun.file(SYNC_CONFIG).text()) as {
    readonly streams: Record<string, { readonly queries?: string[] }>;
  };
  const query = (parsed.streams.authorized_sessions?.queries ?? []).find((item) =>
    new RegExp(`\\bFROM ${table}\\b`).test(item),
  );
  if (query === undefined) throw new Error(`${table} stream query not found`);
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
type Outcome = Record<string, unknown> & { readonly status: string; readonly code?: string };
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
      payload: { username: `se_${suffix}_${counter}`, password: 'correct horse battery staple' },
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
        name: 'Sessions',
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
    input: {
      readonly table: string;
      readonly recordId: string;
      readonly operation: 'insert' | 'update';
      readonly expectedVersion: number | null;
      readonly payload: unknown;
      readonly mutationId?: string;
      readonly audited?: boolean;
    },
  ): Promise<Outcome> => {
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
            mutationId: input.mutationId ?? crypto.randomUUID(),
            campaignId,
            featureId: SESSIONS_SYNC_FEATURE_ID,
            tableName: input.table,
            recordId: input.recordId,
            operation: input.operation,
            expectedVersion: input.expectedVersion,
            payload: input.payload,
            ...(input.audited === true
              ? {
                  audit: {
                    campaignId,
                    action: 'sessions.created',
                    targetType: input.table,
                    targetId: input.recordId,
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
    return (response.json() as { outcomes: Outcome[] }).outcomes[0] as Outcome;
  };
  return { app, signUp, createCampaign, invite, upload };
}

function sessionRecord(campaignId: string, userId: string, number = 7): SessionRecord {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    campaignId,
    type: 'session',
    name: `Session ${number}`,
    tags: [],
    metadata: {},
    visibility: { mode: 'everyone' },
    version: 1,
    createdAt: now,
    createdBy: userId,
    updatedAt: now,
    updatedBy: userId,
    number,
    status: 'active',
    startedAt: now,
    participantUserIds: [userId],
  };
}

function noteRecord(session: SessionRecord, userId: string, body: string): SessionNoteRecord {
  const now = new Date().toISOString();
  return {
    id: session.id,
    campaignId: session.campaignId,
    type: 'session_gm_note',
    name: 'GM notes',
    tags: [],
    metadata: {},
    visibility: { mode: 'gm_only' },
    version: 1,
    createdAt: now,
    createdBy: userId,
    updatedAt: now,
    updatedBy: userId,
    body,
  };
}

function entryRecord(
  session: SessionRecord,
  userId: string,
  overrides: Partial<SessionLogEntryRecord> = {},
): SessionLogEntryRecord {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    campaignId: session.campaignId,
    type: 'session_log_entry',
    name: 'note',
    tags: [],
    metadata: {},
    visibility: { mode: 'gm_only' },
    version: 1,
    createdAt: now,
    createdBy: userId,
    updatedAt: now,
    updatedBy: userId,
    sessionId: session.id,
    kind: 'note',
    text: 'Crates hide a second entrance.',
    ...overrides,
  };
}

async function auditOf(campaignId: string, targetId: string) {
  return db<{ action: string; origin_mutation_id: string }[]>`
    select action, origin_mutation_id from (
      select action, origin_mutation_id, accepted_at from audit_campaign_events
      where campaign_id = ${campaignId} and target_id = ${targetId}
      union all
      select action, origin_mutation_id, accepted_at from audit_private_events
      where campaign_id = ${campaignId} and target_id = ${targetId}
    ) events
    order by accepted_at`.then((rows) => [...rows]);
}

describe.skipIf(!available)('sessions at the authority (PostgreSQL)', () => {
  test('start numbers the session, one open at a time, audited once on retry', async () => {
    const { app, signUp, createCampaign, upload } = await runtime();
    try {
      const gm = await signUp();
      const campaignId = await createCampaign(gm);
      const first = sessionRecord(campaignId, gm.id, 99);
      const mutationId = crypto.randomUUID();
      const insert = {
        table: SESSION_REPLICA_TABLE,
        recordId: first.id,
        operation: 'insert' as const,
        expectedVersion: null,
        payload: first,
        mutationId,
      };
      expect(await upload(gm, campaignId, insert)).toMatchObject({ status: 'accepted' });
      expect(await upload(gm, campaignId, insert)).toMatchObject({ status: 'accepted' });
      const [row] = await db<{ number: number; status: string }[]>`
        select number, status from campaign_sessions where id = ${first.id}`;
      // The device's 99 was a placeholder: the authority assigns the next number (D-04).
      expect(row).toEqual({ number: 1, status: 'active' });
      expect(await auditOf(campaignId, first.id)).toEqual([
        { action: 'session.started', origin_mutation_id: mutationId },
      ]);
      const second = sessionRecord(campaignId, gm.id);
      expect(
        await upload(gm, campaignId, {
          table: SESSION_REPLICA_TABLE,
          recordId: second.id,
          operation: 'insert',
          expectedVersion: null,
          payload: second,
        }),
      ).toMatchObject({ status: 'error', code: 'session_already_open' });
      // A crafted audit envelope is refused (the service audits itself).
      expect(
        await upload(gm, campaignId, { ...insert, mutationId: undefined, audited: true }),
      ).toMatchObject({ status: 'error', code: 'invalid_payload' });
    } finally {
      await app.close();
    }
  });

  test('transitions, scene changes, conflicts, and the final end', async () => {
    const { app, signUp, createCampaign, invite, upload } = await runtime();
    try {
      const gm = await signUp();
      const assistant = await signUp();
      const campaignId = await createCampaign(gm);
      await invite(gm, campaignId, assistant, 'assistant_gm');
      const session = sessionRecord(campaignId, gm.id);
      await upload(gm, campaignId, {
        table: SESSION_REPLICA_TABLE,
        recordId: session.id,
        operation: 'insert',
        expectedVersion: null,
        payload: session,
      });
      const update = (who: Who, payload: SessionRecord, expectedVersion: number) =>
        upload(who, campaignId, {
          table: SESSION_REPLICA_TABLE,
          recordId: session.id,
          operation: 'update',
          expectedVersion,
          payload,
        });
      const scene = crypto.randomUUID();
      expect(await update(gm, { ...session, currentSceneId: scene }, 1)).toMatchObject({
        status: 'accepted',
        acceptedVersion: 2,
      });
      // The assistant GM's change on version 1 is a conflict, nothing overwritten.
      expect(await update(assistant, { ...session, status: 'paused' }, 1)).toMatchObject({
        status: 'conflict',
        actualVersion: 2,
      });
      expect(
        await update(assistant, { ...session, currentSceneId: scene, status: 'paused' }, 2),
      ).toMatchObject({ status: 'accepted' });
      // Invalid: a moved start, then resuming an ended session. The number is the authority's.
      expect(
        await update(
          gm,
          {
            ...session,
            currentSceneId: scene,
            status: 'paused',
            startedAt: new Date(0).toISOString(),
          },
          3,
        ),
      ).toMatchObject({ status: 'error', code: 'invalid_session' });
      expect(
        await update(gm, { ...session, currentSceneId: scene, status: 'active' }, 3),
      ).toMatchObject({ status: 'accepted' });
      const endedAt = new Date().toISOString();
      expect(
        await update(gm, { ...session, currentSceneId: scene, status: 'ended', endedAt }, 4),
      ).toMatchObject({ status: 'accepted' });
      expect(
        await update(gm, { ...session, currentSceneId: scene, status: 'active' }, 5),
      ).toMatchObject({ status: 'error', code: 'invalid_session' });
      expect((await auditOf(campaignId, session.id)).map((event) => event.action)).toEqual([
        'session.started',
        'session.scene_changed',
        'session.paused',
        'session.resumed',
        'session.ended',
      ]);
    } finally {
      await app.close();
    }
  });

  test('players are refused every write; notes are GM-only and versioned; entries follow their rules', async () => {
    const { app, signUp, createCampaign, invite, upload } = await runtime();
    try {
      const gm = await signUp();
      const player = await signUp();
      const campaignId = await createCampaign(gm);
      await invite(gm, campaignId, player, 'player');
      const crafted = sessionRecord(campaignId, player.id);
      expect(
        await upload(player, campaignId, {
          table: SESSION_REPLICA_TABLE,
          recordId: crafted.id,
          operation: 'insert',
          expectedVersion: null,
          payload: crafted,
        }),
      ).toMatchObject({ status: 'error', code: 'not_found_or_forbidden' });
      const session = sessionRecord(campaignId, gm.id);
      await upload(gm, campaignId, {
        table: SESSION_REPLICA_TABLE,
        recordId: session.id,
        operation: 'insert',
        expectedVersion: null,
        payload: session,
      });
      expect(
        await upload(player, campaignId, {
          table: SESSION_REPLICA_TABLE,
          recordId: session.id,
          operation: 'update',
          expectedVersion: 1,
          payload: { ...session, status: 'paused' },
        }),
      ).toMatchObject({ status: 'error', code: 'not_found_or_forbidden' });

      const note = (who: Who, body: string, expectedVersion: number | null) =>
        upload(who, campaignId, {
          table: SESSION_NOTE_REPLICA_TABLE,
          recordId: session.id,
          operation: expectedVersion === null ? 'insert' : 'update',
          expectedVersion,
          payload: noteRecord(session, who.id, body),
        });
      expect(await note(player, 'Peek', null)).toMatchObject({
        status: 'error',
        code: 'not_found_or_forbidden',
      });
      expect(await note(gm, 'Secret door', null)).toMatchObject({ status: 'accepted' });
      expect(await note(gm, 'Secret door, guarded', 1)).toMatchObject({
        status: 'accepted',
        acceptedVersion: 2,
      });
      expect(await note(gm, 'Stale', 1)).toMatchObject({ status: 'conflict', actualVersion: 2 });

      const entry = (who: Who, overrides: Partial<SessionLogEntryRecord>) => {
        const record = entryRecord(session, who.id, overrides);
        return upload(who, campaignId, {
          table: SESSION_LOG_REPLICA_TABLE,
          recordId: record.id,
          operation: 'insert',
          expectedVersion: null,
          payload: record,
        });
      };
      expect(await entry(gm, {})).toMatchObject({ status: 'accepted' });
      expect(
        await entry(gm, { text: 'The bell rings', visibility: { mode: 'everyone' } }),
      ).toMatchObject({ status: 'accepted' });
      expect(await entry(player, {})).toMatchObject({
        status: 'error',
        code: 'not_found_or_forbidden',
      });
      expect(
        await entry(gm, { kind: 'scene', text: 'Old Warehouse', subjectId: crypto.randomUUID() }),
      ).toMatchObject({ status: 'error', code: 'invalid_session' });
      expect(await entry(gm, { sessionId: crypto.randomUUID() })).toMatchObject({
        status: 'error',
        code: 'not_found_or_forbidden',
      });

      // The configured stream: the player holds the session and the public entry only.
      const ids = async (table: string, who: Who) =>
        (await db.unsafe<{ id: string }[]>(await streamQuery(table), [who.id])).map(
          (row) => row.id,
        );
      expect(await ids(SESSION_NOTE_REPLICA_TABLE, player)).not.toContain(session.id);
      expect(await ids(SESSION_NOTE_REPLICA_TABLE, gm)).toContain(session.id);
      expect(await ids(SESSION_REPLICA_TABLE, player)).toContain(session.id);
      const entryTexts = async (who: Who) => {
        const held = await ids(SESSION_LOG_REPLICA_TABLE, who);
        const texts = await db<{ text: string }[]>`
          select text from session_log_entries
          where id = any(${held}::uuid[]) and session_id = ${session.id} order by text`;
        return texts.map((row) => row.text);
      };
      expect(await entryTexts(player)).toEqual(['The bell rings']);
      expect(await entryTexts(gm)).toEqual(['Crates hide a second entrance.', 'The bell rings']);
    } finally {
      await app.close();
    }
  });
});
