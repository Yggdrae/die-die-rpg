import { afterAll, describe, expect, test } from 'bun:test';
import { ResourcePolicyRegistry } from '@rpg/authorization';
import type { EntityRecord } from '@rpg/content';
import {
  connectContentDatabase,
  EntityVisibilityAdapter,
  PostgresEntityRepository,
  PostgresPersonalNoteRepository,
  type PostgresRelationshipRepository,
  RelationshipVisibilityAdapter,
} from '@rpg/content/postgres';
import { err, type Visibility } from '@rpg/contracts';
import { FIXTURE_SYSTEM_DEFINITION } from '@rpg/fixtures';
import postgres from 'postgres';
import { buildApp } from '../../app.ts';
import { buildRuntimeApp } from '../../runtime.ts';
import { ContentAccess } from '../authorization/content-access.ts';
import { registerResourcePolicies } from '../sync/sync-rules.ts';
import { registerContentRoutes } from './routes.ts';

/**
 * Feature 16 task 07 through the runtime composition on PostgreSQL (`_bdd.md` "Reading, Listing,
 * and Filtering", "Nobody else reads a personal note", "Suggestions come from tags the actor can
 * see"): permitted-set lists and totals, byte-identical safe 404s, the Visibility filter, tag
 * suggestions, ignored role claims, and the route inventory. Rows are seeded through the
 * repositories (writes are sync-only) and deleted afterwards.
 */

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const origin = 'https://table.invalid';
const sql =
  databaseUrl === undefined
    ? undefined
    : postgres(databaseUrl, { max: 1, onnotice: () => undefined });
const available = await (async () => {
  if (sql === undefined) return false;
  try {
    await sql`select 1 from content_entities limit 1`;
    return true;
  } catch {
    return false;
  }
})();
const content =
  available && databaseUrl !== undefined ? connectContentDatabase(databaseUrl) : undefined;
const campaigns: string[] = [];

afterAll(async () => {
  if (sql !== undefined && campaigns.length > 0) {
    await sql`delete from content_entities where campaign_id = any(${campaigns}::uuid[])`;
    await sql`delete from content_personal_notes where campaign_id = any(${campaigns}::uuid[])`;
  }
  await content?.close();
  await sql?.end({ timeout: 1 });
});

type Who = { readonly id: string; readonly headers: Record<string, string> };

async function runtime() {
  if (databaseUrl === undefined || sql === undefined || content === undefined) {
    throw new Error('database unavailable');
  }
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
      payload: { username: `cr_${suffix}_${counter}`, password: 'correct horse battery staple' },
    });
    expect(account.statusCode).toBe(200);
    const raw = account.headers['set-cookie'];
    return {
      id: (JSON.parse(account.body) as { user: { id: string } }).user.id,
      headers: { cookie: ((Array.isArray(raw) ? raw[0] : raw) ?? '').split(';')[0] ?? '', origin },
    };
  };
  const campaign = async (owner: Who) => {
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
        name: 'Content routes',
        description: '',
      },
    });
    expect(created.statusCode).toBe(201);
    return campaignId;
  };
  const join = async (campaignId: string, who: Who, role: string) => {
    await sql`insert into identity_campaign_memberships (campaign_id, user_id, role)
      values (${campaignId}, ${who.id}, ${role})`;
  };
  const entities = new PostgresEntityRepository(content.db);
  const notes = new PostgresPersonalNoteRepository(content.db);
  const seed = async (
    campaignId: string,
    by: Who,
    input: { type: string; name: string; visibility: Visibility; tags?: string[] },
  ): Promise<EntityRecord> => {
    const created = await entities.insert(content.db, {
      id: crypto.randomUUID(),
      campaignId,
      type: input.type,
      name: input.name,
      summary: '',
      description: '',
      tags: input.tags ?? [],
      fields: {},
      metadata: {},
      visibility: input.visibility,
      actorUserId: by.id,
    });
    if (!created.ok) throw new Error('seed failed');
    return created.record;
  };
  const get = (who: Who, url: string, headers: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url, headers: { ...who.headers, ...headers } });
  return { app, signUp, campaign, join, seed, get, entities, notes };
}

/** Status, body, and headers except `date` (which differs per response). */
function shape(response: { statusCode: number; body: string; headers: Record<string, unknown> }) {
  const { date: _date, ...headers } = response.headers;
  return { status: response.statusCode, body: response.body, headers };
}

const EVERYONE: Visibility = { mode: 'everyone' };
const GM_ONLY: Visibility = { mode: 'gm_only' };

describe.skipIf(!available)('read-only content routes (runtime, PostgreSQL)', () => {
  test("a player's list holds only permitted NPCs; bytes equal those with hidden rows deleted", async () => {
    const h = await runtime();
    try {
      const owner = await h.signUp();
      const casey = await h.signUp();
      const campaignId = await h.campaign(owner);
      await h.join(campaignId, casey, 'player');
      const hidden: string[] = [];
      for (let index = 0; index < 6; index += 1) {
        const record = await h.seed(campaignId, owner, {
          type: 'npc',
          name: `NPC ${index}`,
          visibility: index < 4 ? EVERYONE : GM_ONLY,
        });
        if (index >= 4) hidden.push(record.id);
      }
      await h.seed(campaignId, owner, {
        type: 'location',
        name: 'Hidden place',
        visibility: GM_ONLY,
      });
      const url = `/campaigns/${campaignId}/entities?type=npc`;
      const before = await h.get(casey, url);
      expect(before.statusCode).toBe(200);
      const body = before.json() as { items: EntityRecord[]; total: number };
      expect(body.total).toBe(4);
      expect(body.items).toHaveLength(4);
      expect(body.items.every((item) => item.visibility.mode === 'everyone')).toBe(true);
      const paged = (await h.get(casey, `${url}&offset=2&limit=1`)).json() as typeof body;
      expect(paged).toMatchObject({ total: 4 });
      expect(paged.items).toHaveLength(1);
      const gmView = (await h.get(owner, url)).json() as typeof body;
      expect(gmView.total).toBe(6);
      // Visibility filter: empty for a player, never an error.
      const filtered = await h.get(casey, `/campaigns/${campaignId}/entities?visibility=gm_only`);
      expect(filtered.statusCode).toBe(200);
      expect(JSON.parse(filtered.body)).toEqual({ items: [], total: 0 });
      expect(
        (
          (await h.get(owner, `/campaigns/${campaignId}/entities?visibility=gm_only`)).json() as {
            total: number;
          }
        ).total,
      ).toBe(3);
      // Name fragment search.
      expect(
        (
          (await h.get(casey, `/campaigns/${campaignId}/entities?q=npc%201`)).json() as typeof body
        ).items.map((item) => item.name),
      ).toEqual(['NPC 1']);
      await (sql as NonNullable<
        typeof sql
      >)`delete from content_entities where id = any(${hidden}::uuid[])`;
      const after = await h.get(casey, url);
      expect(after.body).toBe(before.body);
    } finally {
      await h.app.close();
    }
  });

  test('hidden, missing, foreign-campaign, and another author’s note are the same safe 404', async () => {
    const h = await runtime();
    try {
      const owner = await h.signUp();
      const gm = await h.signUp();
      const casey = await h.signUp();
      const rowan = await h.signUp();
      const campaignId = await h.campaign(owner);
      const otherCampaign = await h.campaign(owner);
      await h.join(campaignId, gm, 'gm');
      await h.join(campaignId, casey, 'player');
      await h.join(campaignId, rowan, 'player');
      const hidden = await h.seed(campaignId, owner, {
        type: 'item',
        name: 'Key',
        visibility: GM_ONLY,
      });
      const visible = await h.seed(campaignId, owner, {
        type: 'item',
        name: 'Lamp',
        visibility: EVERYONE,
      });
      const foreign = await h.seed(otherCampaign, owner, {
        type: 'item',
        name: 'Elsewhere',
        visibility: EVERYONE,
      });
      const noteId = crypto.randomUUID();
      await h.notes.insert(content?.db as NonNullable<typeof content>['db'], {
        id: noteId,
        campaignId,
        authorUserId: casey.id,
        name: 'Elder lied about the road',
        body: 'He did.',
        tags: [],
        metadata: {},
      });
      const reference = shape(
        await h.get(casey, `/campaigns/${campaignId}/entities/${crypto.randomUUID()}`),
      );
      expect(reference.status).toBe(404);
      expect(JSON.parse(reference.body)).toEqual({
        code: 'not_found_or_forbidden',
        message: 'Not found.',
      });
      const denials = [
        h.get(casey, `/campaigns/${campaignId}/entities/${hidden.id}`),
        h.get(casey, `/campaigns/${campaignId}/entities/${foreign.id}`),
        h.get(casey, `/campaigns/${campaignId}/entities/not-a-uuid`),
        h.get(casey, `/campaigns/${otherCampaign}/entities/${foreign.id}`),
        h.get(casey, `/campaigns/${campaignId}/personal-notes/${visible.id}`),
        h.get(rowan, `/campaigns/${campaignId}/personal-notes/${noteId}`),
        h.get(owner, `/campaigns/${campaignId}/personal-notes/${noteId}`),
        h.get(gm, `/campaigns/${campaignId}/personal-notes/${noteId}`),
        h.get(rowan, `/campaigns/${campaignId}/personal-notes/${crypto.randomUUID()}`),
      ];
      for (const response of await Promise.all(denials)) {
        expect(shape(response)).toEqual(reference);
      }
      // The author reads it; the list is the author's own, and GM roles list nothing.
      const own = await h.get(casey, `/campaigns/${campaignId}/personal-notes/${noteId}`);
      expect(own.statusCode).toBe(200);
      expect(own.json()).toMatchObject({ id: noteId, authorUserId: casey.id, body: 'He did.' });
      expect((await h.get(casey, `/campaigns/${campaignId}/personal-notes`)).json()).toMatchObject({
        total: 1,
      });
      for (const reader of [owner, gm, rowan]) {
        expect(
          JSON.parse((await h.get(reader, `/campaigns/${campaignId}/personal-notes`)).body),
        ).toEqual({
          items: [],
          total: 0,
        });
      }
      expect(
        (await h.get(casey, `/campaigns/${campaignId}/entities/${visible.id}`)).json(),
      ).toMatchObject({ id: visible.id, name: 'Lamp' });
    } finally {
      await h.app.close();
    }
  });

  test('tag suggestions never include a tag present only on rows the actor cannot read', async () => {
    const h = await runtime();
    try {
      const owner = await h.signUp();
      const casey = await h.signUp();
      const campaignId = await h.campaign(owner);
      await h.join(campaignId, casey, 'player');
      await h.seed(campaignId, owner, {
        type: 'faction',
        name: 'Cult',
        visibility: GM_ONLY,
        tags: ['secret-cult', 'village'],
      });
      await h.seed(campaignId, owner, {
        type: 'location',
        name: 'Village',
        visibility: EVERYONE,
        tags: ['site', 'village'],
      });
      const tags = async (who: Who, prefix: string) =>
        (
          (await h.get(who, `/campaigns/${campaignId}/entity-tags?prefix=${prefix}`)).json() as {
            tags: string[];
          }
        ).tags;
      expect(await tags(casey, 's')).toEqual(['site']);
      expect(await tags(casey, 'V')).toEqual(['village']);
      expect(await tags(owner, 's')).toEqual(['secret-cult', 'site']);
    } finally {
      await h.app.close();
    }
  });

  test('role claims in headers, query, or cookies change nothing', async () => {
    const h = await runtime();
    try {
      const owner = await h.signUp();
      const casey = await h.signUp();
      const campaignId = await h.campaign(owner);
      await h.join(campaignId, casey, 'player');
      const hidden = await h.seed(campaignId, owner, {
        type: 'npc',
        name: 'Spy',
        visibility: GM_ONLY,
      });
      await h.seed(campaignId, owner, { type: 'npc', name: 'Guard', visibility: EVERYONE });
      const list = `/campaigns/${campaignId}/entities`;
      const baseline = await h.get(casey, list);
      const denied = shape(await h.get(casey, `${list}/${hidden.id}`));
      for (const headers of <Record<string, string>[]>[
        { 'x-role': 'gm' },
        { 'x-campaign-role': 'owner' },
        { role: 'gm' },
        { cookie: `${casey.headers.cookie}; role=gm` },
      ]) {
        expect((await h.get(casey, list, headers)).body).toBe(baseline.body);
        expect(shape(await h.get(casey, `${list}/${hidden.id}`, headers))).toEqual(denied);
      }
      // A query role claim is not an accepted parameter (`additionalProperties: false`): the same
      // 400 for every caller, before any decision, and never a grant.
      for (const query of ['?role=gm', '?actorRole=owner']) {
        for (const who of [casey, owner]) {
          const claimed = await h.get(who, `${list}${query}`);
          expect(claimed.statusCode).toBe(400);
          expect(claimed.json()).toMatchObject({ code: 'validation_failed' });
        }
      }
    } finally {
      await h.app.close();
    }
  });
});

describe('content route inventory', () => {
  test('every content route is guarded by a sanctioned helper', async () => {
    const app = buildApp({ logger: false });
    const unavailable = {
      get: async () => undefined,
      list: async () => [],
      listByAuthor: async () => [],
    };
    const registry = registerResourcePolicies(
      new ResourcePolicyRegistry({ requireVisibilityAdapters: true }),
      [
        new EntityVisibilityAdapter(unavailable as unknown as PostgresEntityRepository),
        new RelationshipVisibilityAdapter(
          unavailable as unknown as PostgresRelationshipRepository,
          unavailable as unknown as PostgresEntityRepository,
        ),
      ],
    );
    const access = new ContentAccess({
      registry,
      actors: { resolve: async () => err('membership_not_found' as const) },
    });
    access.install(app);
    registerContentRoutes(app, {
      access,
      entities: unavailable as unknown as PostgresEntityRepository,
      notes: unavailable as unknown as PostgresPersonalNoteRepository,
      relationships: unavailable as unknown as PostgresRelationshipRepository,
    });
    await app.ready();
    const guarded = access.inventory
      .guarded()
      .filter((entry) => entry.method === 'GET')
      .map((entry) => `${entry.url} ${entry.sanctioned?.kind} ${entry.sanctioned?.resourceClass}`);
    expect(guarded.sort()).toEqual(
      [
        '/campaigns/:campaignId/entities collection campaign_entity',
        '/campaigns/:campaignId/entities/:resourceId resource campaign_entity',
        '/campaigns/:campaignId/entities/:resourceId/relationships resource campaign_entity',
        '/campaigns/:campaignId/entity-tags collection campaign_entity',
        '/campaigns/:campaignId/personal-notes collection personal_note',
        '/campaigns/:campaignId/personal-notes/:resourceId resource personal_note',
      ].sort(),
    );
    expect(access.inventory.violations()).toEqual([]);
    await app.close();
  });
});
