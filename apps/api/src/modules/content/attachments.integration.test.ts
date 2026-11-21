import { afterAll, describe, expect, test } from 'bun:test';
import { BunS3ObjectStorage, s3ConfigFromEnv } from '@rpg/attachments/s3';
import {
  CAMPAIGN_ENTITY_CLASS,
  CONTENT_ATTACHMENT_OWNER_CLASSES,
  PERSONAL_NOTE_CLASS,
} from '@rpg/content';
import { connectContentDatabase, PostgresEntityRepository } from '@rpg/content/postgres';
import type { Visibility } from '@rpg/contracts';
import { FIXTURE_SYSTEM_DEFINITION } from '@rpg/fixtures';
import postgres from 'postgres';
import { buildRuntimeApp } from '../../runtime.ts';
import { PNG, uploadBody } from '../attachments/test-support.ts';

/**
 * Feature 16 task 13 (FR-009, D-15) through the runtime composition with `ownerClasses` from
 * `CONTENT_ATTACHMENT_OWNER_CLASSES` (as `main.ts` passes it), over PostgreSQL and MinIO:
 * `_bdd.md` "A GM attaches a portrait to an NPC", "A hidden entity's attachment is unreachable",
 * "A personal note takes no attachments or links". Skipped when either store is unreachable.
 */

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const origin = 'https://table.invalid';
const storage = new BunS3ObjectStorage(s3ConfigFromEnv(process.env));
const sql =
  databaseUrl === undefined
    ? undefined
    : postgres(databaseUrl, { max: 1, onnotice: () => undefined });
const available = await (async () => {
  if (sql === undefined) return false;
  try {
    await sql`select 1 from content_entities limit 1`;
    await sql`select 1 from attachments limit 1`;
    await storage.inspect('campaigns/probe/probe/probe');
    return true;
  } catch {
    return false;
  }
})();
const content =
  available && databaseUrl !== undefined ? connectContentDatabase(databaseUrl) : undefined;
const campaigns: string[] = [];

afterAll(async () => {
  if (sql !== undefined && available && campaigns.length > 0) {
    const rows = await sql<{ object_key: string }[]>`
      select object_key from attachments where campaign_id = any(${campaigns}::uuid[])`;
    for (const row of rows) await storage.delete(row.object_key);
    await sql`delete from attachments where campaign_id = any(${campaigns}::uuid[])`;
    await sql`delete from content_entities where campaign_id = any(${campaigns}::uuid[])`;
  }
  await content?.close();
  await sql?.end({ timeout: 1 });
});

describe.skipIf(!available)('entity attachments through the runtime (task 13)', () => {
  test('a PNG on an NPC is listed there; a gm_only NPC hides it from players; notes take none', async () => {
    if (databaseUrl === undefined || sql === undefined || content === undefined) return;
    const app = buildRuntimeApp({
      databaseUrl,
      allowedOrigin: origin,
      production: false,
      powerSyncEndpoint: 'http://localhost:8080',
      powerSyncJwtSecret: 'ZGV2ZWxvcG1lbnQtb25seS1wb3dlcnN5bmMta2V5LTMyIQ',
      systems: [FIXTURE_SYSTEM_DEFINITION],
      logger: false,
      attachments: { storage, ownerClasses: CONTENT_ATTACHMENT_OWNER_CLASSES },
    });
    try {
      await app.ready();
      const suffix = crypto.randomUUID().slice(0, 8);
      const signUp = async (name: string) => {
        const account = await app.inject({
          method: 'POST',
          url: '/auth/accounts',
          payload: { username: `ca_${name}_${suffix}`, password: 'correct horse battery staple' },
        });
        const raw = account.headers['set-cookie'];
        return {
          id: (account.json() as { user: { id: string } }).user.id,
          headers: {
            cookie: ((Array.isArray(raw) ? raw[0] : raw) ?? '').split(';')[0] ?? '',
            origin,
          },
        };
      };
      const gm = await signUp('gm');
      const player = await signUp('player');
      const campaignId = crypto.randomUUID();
      campaigns.push(campaignId);
      const created = await app.inject({
        method: 'POST',
        url: '/campaigns',
        headers: gm.headers,
        payload: {
          id: campaignId,
          system: FIXTURE_SYSTEM_DEFINITION.summary.ref,
          gameMode: 'standard',
          options: {},
          moduleIds: [],
          name: 'Entity attachments',
          description: '',
        },
      });
      expect(created.statusCode).toBe(201);
      await sql`insert into identity_campaign_memberships (campaign_id, user_id, role)
        values (${campaignId}, ${player.id}, 'player')`;
      const entities = new PostgresEntityRepository(content.db);
      const npc = async (name: string, visibility: Visibility) => {
        const inserted = await entities.insert(content.db, {
          id: crypto.randomUUID(),
          campaignId,
          type: 'npc',
          name,
          summary: '',
          description: '',
          tags: [],
          fields: {},
          metadata: {},
          visibility,
          actorUserId: gm.id,
        });
        if (!inserted.ok) throw new Error('seed failed');
        return inserted.record;
      };
      const ferryman = await npc('Ferryman', { mode: 'everyone' });
      const smuggler = await npc('Smuggler', { mode: 'gm_only' });

      const attach = async (
        owner: { resourceClass: string; resourceId: string },
        visibility: Visibility,
      ) => {
        const body = uploadBody(PNG, { owner, visibility, filename: 'portrait.png' });
        const permission = await app.inject({
          method: 'POST',
          url: `/campaigns/${campaignId}/attachments/uploads`,
          headers: gm.headers,
          payload: body as unknown as Record<string, unknown>,
        });
        if (permission.statusCode !== 201) return { permission };
        const { attachment, upload } = permission.json();
        const put = await fetch(upload.url, {
          method: upload.method,
          headers: upload.headers,
          body: PNG,
        });
        expect(put.status).toBe(200);
        const finalized = await app.inject({
          method: 'POST',
          url: `/campaigns/${campaignId}/attachments/${attachment.attachmentId}/finalize`,
          headers: gm.headers,
          payload: { size: body.size, checksum: body.checksum },
        });
        expect(finalized.statusCode).toBe(200);
        return { permission, id: attachment.attachmentId as string };
      };
      const list = (who: { headers: Record<string, string> }, entityId: string) =>
        app.inject({
          method: 'GET',
          url: `/campaigns/${campaignId}/resources/${CAMPAIGN_ENTITY_CLASS}/${entityId}/attachments`,
          headers: who.headers,
        });
      const read = (who: { headers: Record<string, string> }, attachmentId: string) =>
        app.inject({
          method: 'GET',
          url: `/campaigns/${campaignId}/attachments/${attachmentId}/read`,
          headers: who.headers,
        });

      // A GM attaches a portrait to an NPC: listed on that NPC, readable as the NPC is.
      const portrait = await attach(
        { resourceClass: CAMPAIGN_ENTITY_CLASS, resourceId: ferryman.id },
        ferryman.visibility,
      );
      expect(portrait.permission.statusCode).toBe(201);
      for (const who of [gm, player]) {
        const listed = await list(who, ferryman.id);
        expect(listed.statusCode).toBe(200);
        expect(
          (listed.json() as { items: { attachmentId: string; filename: string }[] }).items.map(
            (item) => [item.attachmentId, item.filename],
          ),
        ).toEqual([[portrait.id ?? '', 'portrait.png']]);
      }
      expect((await read(player, portrait.id ?? '')).statusCode).toBe(200);

      // A hidden entity's attachment is unreachable: never listed, direct read = missing.
      const hidden = await attach(
        { resourceClass: CAMPAIGN_ENTITY_CLASS, resourceId: smuggler.id },
        smuggler.visibility,
      );
      expect(hidden.permission.statusCode).toBe(201);
      expect((await list(gm, smuggler.id)).statusCode).toBe(200);
      const hiddenList = await list(player, smuggler.id);
      const hiddenRead = await read(player, hidden.id ?? '');
      const missingRead = await read(player, crypto.randomUUID());
      for (const response of [hiddenList, hiddenRead]) {
        expect([response.statusCode, response.json()]).toEqual([
          missingRead.statusCode,
          missingRead.json(),
        ]);
      }
      expect(missingRead.statusCode).toBe(404);

      // An attachment never widens its owner: marked `everyone` on a gm_only NPC, it still
      // answers a player exactly like a missing attachment (owner decision AND its own).
      const widened = await attach(
        { resourceClass: CAMPAIGN_ENTITY_CLASS, resourceId: smuggler.id },
        { mode: 'everyone' },
      );
      expect(widened.permission.statusCode).toBe(201);
      const widenedRead = await read(player, widened.id ?? '');
      expect([widenedRead.statusCode, widenedRead.json()]).toEqual([
        missingRead.statusCode,
        missingRead.json(),
      ]);

      // Personal notes, relationships, the campaign: not owner classes (safe 404, nothing stored).
      expect(CONTENT_ATTACHMENT_OWNER_CLASSES).toEqual([CAMPAIGN_ENTITY_CLASS]);
      for (const resourceClass of [PERSONAL_NOTE_CLASS, 'entity_relationship', 'campaign']) {
        const refused = await attach(
          { resourceClass, resourceId: resourceClass === 'campaign' ? campaignId : ferryman.id },
          { mode: 'gm_only' },
        );
        expect([refused.permission.statusCode, refused.permission.json()]).toEqual([
          404,
          { code: 'not_found_or_forbidden', message: 'Not found.' },
        ]);
      }
      const [{ count }] = (await sql`
        select count(*)::int as count from attachments where campaign_id = ${campaignId}`) as unknown as [
        { count: number },
      ];
      expect(count).toBe(3);
    } finally {
      await app.close();
    }
  });
});
