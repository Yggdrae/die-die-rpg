import { afterAll, describe, expect, test } from 'bun:test';
import {
  connectContentDatabase,
  PostgresEntityRepository,
  PostgresPersonalNoteRepository,
} from '@rpg/content/postgres';
import { FIXTURE_SYSTEM_DEFINITION } from '@rpg/fixtures';
import postgres from 'postgres';
import { buildRuntimeApp } from '../../runtime.ts';

/**
 * Feature 16 task 03 through the runtime composition: the generic feature 04 route
 * `PATCH /campaigns/:campaignId/resources/campaign_entity/:id/visibility` reveals, un-reveals,
 * conflicts, and audits on PostgreSQL (`_bdd.md` "Reveal and un-reveal go through feature 04",
 * "A player cannot change visibility"); `personal_note` on the same route is the safe 404 ("A
 * personal note cannot be revealed"). Entity rows are seeded through the repository (no create path
 * exists before task 06) and deleted afterwards; audit rows are append-only and stay.
 */

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const origin = 'https://table.invalid';
const sql = databaseUrl === undefined ? undefined : postgres(databaseUrl, { max: 1 });
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
const seededCampaigns: string[] = [];

afterAll(async () => {
  if (sql !== undefined && seededCampaigns.length > 0) {
    await sql`delete from content_entities where campaign_id = any(${seededCampaigns}::uuid[])`;
    await sql`delete from content_personal_notes where campaign_id = any(${seededCampaigns}::uuid[])`;
  }
  await content?.close();
  await sql?.end({ timeout: 1 });
});

describe.skipIf(!available)('campaign_entity visibility through the generic route', () => {
  test('reveal, conflict, targeted reveal, un-reveal, audit; players and personal notes denied', async () => {
    if (databaseUrl === undefined || sql === undefined || content === undefined) return;
    const app = buildRuntimeApp({
      databaseUrl,
      allowedOrigin: origin,
      production: false,
      powerSyncEndpoint: 'http://localhost:8080',
      powerSyncJwtSecret: 'ZGV2ZWxvcG1lbnQtb25seS1wb3dlcnN5bmMta2V5LTMyIQ',
      systems: [FIXTURE_SYSTEM_DEFINITION],
      logger: false,
    });
    try {
      await app.ready();
      const suffix = crypto.randomUUID().slice(0, 8);
      const signUp = async (username: string) => {
        const account = await app.inject({
          method: 'POST',
          url: '/auth/accounts',
          payload: { username, password: 'correct horse battery staple' },
        });
        expect(account.statusCode).toBe(200);
        const raw = account.headers['set-cookie'];
        return {
          id: (JSON.parse(account.body) as { user: { id: string } }).user.id,
          headers: {
            cookie: ((Array.isArray(raw) ? raw[0] : raw) ?? '').split(';')[0] ?? '',
            origin,
          },
        };
      };
      const owner = await signUp(`ent_${suffix}`);
      const player = await signUp(`ent_p_${suffix}`);
      const campaignId = crypto.randomUUID();
      seededCampaigns.push(campaignId);
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
          name: 'Entity visibility',
          description: '',
        },
      });
      expect(created.statusCode).toBe(201);
      await sql`insert into identity_campaign_memberships (campaign_id, user_id, role)
        values (${campaignId}, ${player.id}, 'player')`;

      const entities = new PostgresEntityRepository(content.db);
      const itemId = crypto.randomUUID();
      const seeded = await entities.insert(content.db, {
        id: itemId,
        campaignId,
        type: 'item',
        name: 'Silver key',
        summary: '',
        description: '',
        tags: [],
        fields: {},
        metadata: {},
        visibility: { mode: 'gm_only' },
        actorUserId: owner.id,
      });
      expect(seeded.ok).toBe(true);
      const noteId = crypto.randomUUID();
      await new PostgresPersonalNoteRepository(content.db).insert(content.db, {
        id: noteId,
        campaignId,
        authorUserId: player.id,
        name: 'Elder lied about the road',
        body: '',
        tags: [],
        metadata: {},
      });

      const patch = (
        who: { headers: Record<string, string> },
        resourceClass: string,
        id: string,
        payload: object,
      ) =>
        app.inject({
          method: 'PATCH',
          url: `/campaigns/${campaignId}/resources/${resourceClass}/${id}/visibility`,
          headers: who.headers,
          payload,
        });
      const everyone = { mode: 'everyone' };

      // A player cannot change visibility: safe 404, unchanged.
      const byPlayer = await patch(player, 'campaign_entity', itemId, {
        operation: 'reveal',
        target: everyone,
        expectedVersion: 1,
      });
      expect(byPlayer.statusCode).toBe(404);
      const missing = await patch(owner, 'campaign_entity', crypto.randomUUID(), {
        operation: 'reveal',
        target: everyone,
        expectedVersion: 1,
      });
      expect(missing.statusCode).toBe(404);
      expect(byPlayer.body).toBe(missing.body);
      expect((await entities.get(campaignId, itemId))?.version).toBe(1);

      const revealed = await patch(owner, 'campaign_entity', itemId, {
        operation: 'reveal',
        target: everyone,
        expectedVersion: 1,
      });
      expect(revealed.statusCode).toBe(200);
      expect(JSON.parse(revealed.body)).toEqual({
        resourceClass: 'campaign_entity',
        resourceId: itemId,
        visibility: everyone,
        version: 2,
        changed: true,
      });
      const stale = await patch(owner, 'campaign_entity', itemId, {
        operation: 'unreveal',
        target: everyone,
        expectedVersion: 1,
      });
      expect(stale.statusCode).toBe(409);
      const hidden = await patch(owner, 'campaign_entity', itemId, {
        operation: 'unreveal',
        target: everyone,
        expectedVersion: 2,
      });
      expect(JSON.parse(hidden.body)).toMatchObject({
        visibility: { mode: 'gm_only' },
        version: 3,
      });
      const toPlayer = await patch(owner, 'campaign_entity', itemId, {
        operation: 'reveal',
        target: { mode: 'players', playerIds: [player.id] },
        expectedVersion: 3,
      });
      expect(JSON.parse(toPlayer.body)).toMatchObject({
        visibility: { mode: 'players', playerIds: [player.id] },
        version: 4,
      });
      const removed = await patch(owner, 'campaign_entity', itemId, {
        operation: 'unreveal',
        target: { mode: 'players', playerIds: [player.id] },
        expectedVersion: 4,
      });
      expect(JSON.parse(removed.body)).toMatchObject({
        visibility: { mode: 'gm_only' },
        version: 5,
      });
      const stored = await entities.get(campaignId, itemId);
      expect([stored?.visibility, stored?.version, stored?.name]).toEqual([
        { mode: 'gm_only' },
        5,
        'Silver key',
      ]);

      // Each accepted change audited once, in order; the rejected ones not at all.
      const events = await sql<{ action: string; target_type: string }[]>`
        select action, target_type from audit_campaign_events
        where campaign_id = ${campaignId} and target_id = ${itemId}
        order by campaign_sequence`;
      expect([...events]).toEqual([
        { action: 'visibility.revealed', target_type: 'campaign_entity' },
        { action: 'visibility.unrevealed', target_type: 'campaign_entity' },
        { action: 'visibility.revealed', target_type: 'campaign_entity' },
        { action: 'visibility.unrevealed', target_type: 'campaign_entity' },
      ]);

      // A personal note cannot be revealed, by its author or a GM role: the safe 404.
      for (const who of [player, owner]) {
        const note = await patch(who, 'personal_note', noteId, {
          operation: 'reveal',
          target: everyone,
          expectedVersion: 1,
        });
        expect(note.statusCode).toBe(404);
        expect(note.body).toBe(missing.body);
      }
      const [noteRow] = await sql<{ visibility_mode: string; version: string }[]>`
        select visibility_mode, version from content_personal_notes where id = ${noteId}`;
      expect([noteRow?.visibility_mode, Number(noteRow?.version)]).toEqual(['players', 1]);
    } finally {
      await app.close();
    }
  }, 60_000);
});
