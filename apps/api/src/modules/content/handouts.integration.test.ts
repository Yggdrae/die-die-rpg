import { afterAll, describe, expect, test } from 'bun:test';
import { BunS3ObjectStorage, s3ConfigFromEnv } from '@rpg/attachments/s3';
import {
  attachmentVisibilityFor,
  CAMPAIGN_ENTITY_CLASS,
  CONTENT_ATTACHMENT_OWNER_CLASSES,
  CONTENT_SYNC_FEATURE_ID,
  ENTITY_REPLICA_TABLE,
  HANDOUT_ENTITY_TYPE,
} from '@rpg/content';
import type { Role, Visibility } from '@rpg/contracts';
import { FIXTURE_SYSTEM_DEFINITION } from '@rpg/fixtures';
import postgres from 'postgres';
import { buildRuntimeApp } from '../../runtime.ts';
import { PNG, uploadBody } from '../attachments/test-support.ts';

/**
 * Feature 17 on PostgreSQL through the real composition root: a reveal is a queued entity update
 * carrying `visibilityChange` and no envelope (D-03), decided and audited by feature 04
 * `VisibilityService` against the previewed version (D-04); a handout's attachments follow it
 * (D-06); and the configured `authorized_content` stream query returns a hidden handout to no
 * player and a revealed one to its recipients only (`PRD.md` s.87 Test 3). The live PowerSync
 * counterpart is in `sync-config.powersync.integration.test.ts`.
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
    await sql`select 1 from content_entities, audit_campaign_events limit 1`;
    return true;
  } catch {
    return false;
  }
})();
const storage = new BunS3ObjectStorage(s3ConfigFromEnv(process.env));
const storageAvailable = await (async () => {
  if (!available) return false;
  try {
    await storage.inspect('campaigns/probe/probe/probe');
    return true;
  } catch {
    return false;
  }
})();
const campaigns: string[] = [];

afterAll(async () => {
  if (available && campaigns.length > 0) {
    if (storageAvailable) {
      const rows = await db<{ object_key: string }[]>`
        select object_key from attachments where campaign_id = any(${campaigns}::uuid[])`;
      for (const row of rows) await storage.delete(row.object_key);
      await db`delete from attachments where campaign_id = any(${campaigns}::uuid[])`;
    }
    await db`delete from content_entities where campaign_id = any(${campaigns}::uuid[])`;
    await db`delete from sync_mutation_receipts where campaign_id = any(${campaigns}::uuid[])`;
  }
  await sql?.end({ timeout: 1 });
});

const SYNC_CONFIG = new URL('../../../../../infra/powersync/sync-config.yaml', import.meta.url);

/** The configured content stream query over `content_entities`, as PostgreSQL (requester `$1`). */
async function entityStreamQuery(): Promise<string> {
  const parsed = Bun.YAML.parse(await Bun.file(SYNC_CONFIG).text()) as {
    readonly streams: Record<string, { readonly queries?: string[] }>;
  };
  const query = (parsed.streams.authorized_content?.queries ?? []).find((item) =>
    /\bFROM content_entities\b/.test(item),
  );
  if (query === undefined) throw new Error('content_entities stream query not found');
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
type Outcome = Record<string, unknown> & { readonly status: string };
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
    ...(storageAvailable
      ? { attachments: { storage, ownerClasses: CONTENT_ATTACHMENT_OWNER_CLASSES } }
      : {}),
  });
  await app.ready();
  const suffix = crypto.randomUUID().slice(0, 8);
  let counter = 0;
  const signUp = async (): Promise<Who> => {
    counter += 1;
    const account = await app.inject({
      method: 'POST',
      url: '/auth/accounts',
      payload: { username: `ho_${suffix}_${counter}`, password: 'correct horse battery staple' },
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
        name: 'Handouts',
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
      readonly recordId: string;
      readonly operation: 'insert' | 'update';
      readonly expectedVersion: number | null;
      readonly payload: unknown;
      readonly audited: boolean;
      readonly mutationId?: string;
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
            featureId: CONTENT_SYNC_FEATURE_ID,
            tableName: ENTITY_REPLICA_TABLE,
            recordId: input.recordId,
            operation: input.operation,
            expectedVersion: input.expectedVersion,
            payload: input.payload,
            ...(input.audited
              ? {
                  audit: {
                    campaignId,
                    action: 'content.changed',
                    targetType: ENTITY_REPLICA_TABLE,
                    targetId: input.recordId,
                    at,
                    private: true,
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

function handoutRecord(id: string, campaignId: string, userId: string, version = 1) {
  const now = new Date().toISOString();
  return {
    id,
    campaignId,
    type: HANDOUT_ENTITY_TYPE,
    name: 'Weathered letter',
    summary: '',
    description: 'Meet me at the ford at midnight.',
    tags: [],
    fields: {},
    metadata: {},
    visibility: { mode: 'gm_only' } as Visibility,
    version,
    createdAt: now,
    createdBy: userId,
    updatedAt: now,
    updatedBy: userId,
  };
}

async function stored(id: string) {
  const [row] = await db<
    { visibility_mode: string; visibility_targets: string[]; version: number }[]
  >`
    select visibility_mode, visibility_targets, version::int as version
    from content_entities where id = ${id}`;
  return row;
}

async function auditOf(campaignId: string, targetId: string) {
  // Campaign and private stores both: a change to or from GM-only may land in either.
  return db<{ action: string; origin_mutation_id: string }[]>`
    select action, origin_mutation_id from (
      select action, origin_mutation_id, accepted_at from audit_campaign_events
      where campaign_id = ${campaignId} and target_id = ${targetId}
      union all
      select action, origin_mutation_id, accepted_at from audit_private_events
      where campaign_id = ${campaignId} and target_id = ${targetId}
    ) events
    where action like 'visibility.%'
    order by accepted_at`.then((rows) => [...rows]);
}

describe.skipIf(!available)('feature 17 handouts (runtime + PostgreSQL)', () => {
  test('a queued reveal applies through feature 04, once, with one audit event; the stream follows', async () => {
    const h = await runtime();
    try {
      const gm = await h.signUp();
      const ana = await h.signUp();
      const bruno = await h.signUp();
      const campaignId = await h.createCampaign(gm);
      await h.invite(gm, campaignId, ana, 'player');
      await h.invite(gm, campaignId, bruno, 'player');
      const id = crypto.randomUUID();
      const record = handoutRecord(id, campaignId, gm.id);
      expect(
        (
          await h.upload(gm, campaignId, {
            recordId: id,
            operation: 'insert',
            expectedVersion: null,
            payload: record,
            audited: true,
          })
        ).status,
      ).toBe('accepted');
      const query = await entityStreamQuery();
      const streamed = async (who: Who) =>
        (await db.unsafe<{ id: string }[]>(query, [who.id])).map((row) => row.id);
      // Hidden: no player's stream carries it.
      expect(await streamed(ana)).not.toContain(id);
      expect(await streamed(bruno)).not.toContain(id);
      expect(await streamed(gm)).toContain(id);

      const change = { operation: 'reveal', target: { mode: 'players', playerIds: [ana.id] } };
      const revealPayload = {
        ...record,
        version: 2,
        visibility: { mode: 'players', playerIds: [ana.id] },
        visibilityChange: change,
      };
      const mutationId = crypto.randomUUID();
      const revealed = await h.upload(gm, campaignId, {
        recordId: id,
        operation: 'update',
        expectedVersion: 1,
        payload: revealPayload,
        audited: false,
        mutationId,
      });
      expect(revealed).toMatchObject({ status: 'accepted', acceptedVersion: 2 });
      expect(await stored(id)).toEqual({
        visibility_mode: 'players',
        visibility_targets: [ana.id],
        version: 2,
      });
      expect(await streamed(ana)).toContain(id);
      expect(await streamed(bruno)).not.toContain(id);

      // A lost acknowledgement: the same mutation again changes nothing and records nothing.
      const replay = await h.upload(gm, campaignId, {
        recordId: id,
        operation: 'update',
        expectedVersion: 1,
        payload: revealPayload,
        audited: false,
        mutationId,
      });
      expect(replay).toMatchObject({ status: 'accepted', acceptedVersion: 2 });
      expect(await auditOf(campaignId, id)).toEqual([
        { action: 'visibility.revealed', origin_mutation_id: mutationId },
      ]);

      // Un-reveal returns it to hidden, audited, and it leaves Ana's stream.
      const hidden = await h.upload(gm, campaignId, {
        recordId: id,
        operation: 'update',
        expectedVersion: 2,
        payload: {
          ...record,
          version: 3,
          visibilityChange: { operation: 'unreveal', target: { mode: 'everyone' } },
        },
        audited: false,
      });
      expect(hidden).toMatchObject({ status: 'accepted', acceptedVersion: 3 });
      expect((await stored(id))?.visibility_mode).toBe('gm_only');
      expect(await streamed(ana)).not.toContain(id);
      expect((await auditOf(campaignId, id)).map((row) => row.action)).toEqual([
        'visibility.revealed',
        'visibility.unrevealed',
      ]);
    } finally {
      await h.app.close();
    }
  }, 60_000);

  test('the reveal is what was previewed: a stale version is a conflict and reveals nothing', async () => {
    const h = await runtime();
    try {
      const gm = await h.signUp();
      const ana = await h.signUp();
      const campaignId = await h.createCampaign(gm);
      await h.invite(gm, campaignId, ana, 'player');
      const id = crypto.randomUUID();
      const record = handoutRecord(id, campaignId, gm.id);
      await h.upload(gm, campaignId, {
        recordId: id,
        operation: 'insert',
        expectedVersion: null,
        payload: record,
        audited: true,
      });
      // Another GM edits the text: version 2.
      expect(
        (
          await h.upload(gm, campaignId, {
            recordId: id,
            operation: 'update',
            expectedVersion: 1,
            payload: { ...record, version: 2, name: 'Forged letter' },
            audited: true,
          })
        ).status,
      ).toBe('accepted');
      const stale = await h.upload(gm, campaignId, {
        recordId: id,
        operation: 'update',
        expectedVersion: 1,
        payload: {
          ...record,
          version: 2,
          visibilityChange: { operation: 'reveal', target: { mode: 'everyone' } },
        },
        audited: false,
      });
      expect(stale).toMatchObject({ status: 'conflict', actualVersion: 2 });
      expect((stale.currentValue as { name: string }).name).toBe('Forged letter');
      expect((await stored(id))?.visibility_mode).toBe('gm_only');
      expect(await auditOf(campaignId, id)).toEqual([]);
    } finally {
      await h.app.close();
    }
  }, 60_000);

  test('players, envelopes, malformed intents, and strangers as targets are refused', async () => {
    const h = await runtime();
    try {
      const gm = await h.signUp();
      const ana = await h.signUp();
      const stranger = await h.signUp();
      const campaignId = await h.createCampaign(gm);
      await h.invite(gm, campaignId, ana, 'player');
      const id = crypto.randomUUID();
      const record = handoutRecord(id, campaignId, gm.id);
      await h.upload(gm, campaignId, {
        recordId: id,
        operation: 'insert',
        expectedVersion: null,
        payload: record,
        audited: true,
      });
      const reveal = (target: unknown) => ({
        ...record,
        version: 2,
        visibilityChange: { operation: 'reveal', target },
      });
      const attempt = (who: Who, payload: unknown, audited = false) =>
        h.upload(who, campaignId, {
          recordId: id,
          operation: 'update',
          expectedVersion: 1,
          payload,
          audited,
        });
      expect(await attempt(ana, reveal({ mode: 'players', playerIds: [ana.id] }))).toMatchObject({
        status: 'error',
        code: 'not_found_or_forbidden',
      });
      expect(await attempt(gm, reveal({ mode: 'everyone' }), true)).toMatchObject({
        code: 'invalid_payload',
      });
      expect(await attempt(gm, reveal({ mode: 'party', partyIds: [ana.id] }))).toMatchObject({
        code: 'invalid_payload',
      });
      expect(
        await attempt(gm, reveal({ mode: 'players', playerIds: [stranger.id] })),
      ).toMatchObject({ code: 'invalid_visibility' });
      expect((await stored(id))?.visibility_mode).toBe('gm_only');
      // Without the intent, an update still may not change Visibility (feature 16).
      expect(
        await attempt(gm, { ...record, version: 2, visibility: { mode: 'everyone' } }, true),
      ).toMatchObject({ status: 'error', code: 'invalid_payload' });
    } finally {
      await h.app.close();
    }
  }, 60_000);

  test.skipIf(!storageAvailable)(
    'an image on a handout follows it: hidden, then readable by its recipient only',
    async () => {
      const h = await runtime();
      try {
        const gm = await h.signUp();
        const ana = await h.signUp();
        const bruno = await h.signUp();
        const campaignId = await h.createCampaign(gm);
        await h.invite(gm, campaignId, ana, 'player');
        await h.invite(gm, campaignId, bruno, 'player');
        const id = crypto.randomUUID();
        const record = handoutRecord(id, campaignId, gm.id);
        await h.upload(gm, campaignId, {
          recordId: id,
          operation: 'insert',
          expectedVersion: null,
          payload: record,
          audited: true,
        });
        const owner = { resourceClass: CAMPAIGN_ENTITY_CLASS, resourceId: id };
        const body = uploadBody(PNG, {
          owner,
          visibility: attachmentVisibilityFor(HANDOUT_ENTITY_TYPE, record.visibility),
          filename: 'map.png',
        });
        const permission = await h.app.inject({
          method: 'POST',
          url: `/campaigns/${campaignId}/attachments/uploads`,
          headers: gm.headers,
          payload: body as unknown as Record<string, unknown>,
        });
        expect(permission.statusCode).toBe(201);
        const { attachment, upload } = permission.json();
        const put = await fetch(upload.url, {
          method: upload.method,
          headers: upload.headers,
          body: PNG,
        });
        expect(put.status).toBe(200);
        const finalized = await h.app.inject({
          method: 'POST',
          url: `/campaigns/${campaignId}/attachments/${attachment.attachmentId}/finalize`,
          headers: gm.headers,
          payload: { size: body.size, checksum: body.checksum },
        });
        expect(finalized.statusCode).toBe(200);
        const read = (who: Who) =>
          h.app.inject({
            method: 'GET',
            url: `/campaigns/${campaignId}/attachments/${attachment.attachmentId}/read`,
            headers: who.headers,
          });
        expect((await read(gm)).statusCode).toBe(200);
        expect((await read(ana)).statusCode).toBe(404);
        expect((await read(bruno)).statusCode).toBe(404);
        await h.upload(gm, campaignId, {
          recordId: id,
          operation: 'update',
          expectedVersion: 1,
          payload: {
            ...record,
            version: 2,
            visibilityChange: {
              operation: 'reveal',
              target: { mode: 'players', playerIds: [ana.id] },
            },
          },
          audited: false,
        });
        expect((await read(ana)).statusCode).toBe(200);
        expect((await read(bruno)).statusCode).toBe(404);
      } finally {
        await h.app.close();
      }
    },
    60_000,
  );
});
