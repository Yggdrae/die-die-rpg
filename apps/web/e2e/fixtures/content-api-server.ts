import { BunS3ObjectStorage, s3ConfigFromEnv } from '@rpg/attachments/s3';
import { CONTENT_ATTACHMENT_OWNER_CLASSES } from '@rpg/content';
import { FIXTURE_SYSTEM_DEFINITION } from '@rpg/fixtures';
import postgres from 'postgres';
import { buildRuntimeApp } from '../../../api/src/runtime.ts';

/**
 * Bun helper for `content.e2e.ts` (Playwright runs under Node; Fastify, PostgreSQL, the sync
 * authority, holds, and attachments run here). `serve <port>` starts the real API composition root
 * with the production attachment owner classes and the running PowerSync service, signs up a GM,
 * an assistant GM and two players, creates the GM's campaign, invites and joins the others through
 * the identity routes, and prints one JSON line with their session cookies. `cleanup <campaignId>`
 * removes the run's content, holds, receipts, and attachment objects.
 */

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required');
export const API_ORIGIN = 'https://table.invalid';
const storage = new BunS3ObjectStorage(s3ConfigFromEnv(process.env));
const [command, ...args] = process.argv.slice(2);

if (command === 'serve') {
  const port = Number(args[0] ?? '4188');
  const app = buildRuntimeApp({
    databaseUrl,
    allowedOrigin: API_ORIGIN,
    production: false,
    powerSyncEndpoint: process.env.POWERSYNC_ENDPOINT ?? 'http://localhost:8080',
    powerSyncJwtSecret:
      process.env.POWERSYNC_JWT_SECRET ?? 'ZGV2ZWxvcG1lbnQtb25seS1wb3dlcnN5bmMta2V5LTMyIQ',
    version: 'e2e',
    logger: false,
    systems: [FIXTURE_SYSTEM_DEFINITION],
    attachments: { storage, ownerClasses: CONTENT_ATTACHMENT_OWNER_CLASSES },
  });
  const suffix = crypto.randomUUID().slice(0, 8);
  const signUp = async (name: string) => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/accounts',
      payload: { username: `${name}_${suffix}`, password: 'correct horse battery staple' },
    });
    if (response.statusCode !== 200) throw new Error(`sign-up failed: ${response.statusCode}`);
    const raw = response.headers['set-cookie'];
    const header = Array.isArray(raw) ? raw[0] : raw;
    return {
      cookie: (header ?? '').split(';')[0] ?? '',
      userId: response.json().user.id as string,
      username: `${name}_${suffix}`,
    };
  };
  const gm = await signUp('gm_avery');
  const assistant = await signUp('agm_blake');
  const casey = await signUp('casey');
  const dana = await signUp('dana');
  const campaignId = crypto.randomUUID();
  const created = await app.inject({
    method: 'POST',
    url: '/campaigns',
    headers: { cookie: gm.cookie, origin: API_ORIGIN },
    payload: {
      id: campaignId,
      system: FIXTURE_SYSTEM_DEFINITION.summary.ref,
      gameMode: 'standard',
      options: {},
      moduleIds: [],
      name: 'River crossing',
      description: '',
    },
  });
  if (created.statusCode !== 201) throw new Error(`campaign create failed: ${created.statusCode}`);
  for (const [member, role] of [
    [assistant, 'assistant_gm'],
    [casey, 'player'],
    [dana, 'player'],
  ] as const) {
    const invited = await app.inject({
      method: 'POST',
      url: `/campaigns/${campaignId}/invitations`,
      headers: { cookie: gm.cookie, origin: API_ORIGIN },
      payload: { targetRole: role },
    });
    if (invited.statusCode !== 201) throw new Error(`invite failed: ${invited.statusCode}`);
    const accepted = await app.inject({
      method: 'POST',
      url: `/invitations/${invited.json().token}/accept`,
      headers: { cookie: member.cookie, origin: API_ORIGIN },
    });
    if (accepted.statusCode !== 200) throw new Error(`accept failed: ${accepted.statusCode}`);
  }
  await app.listen({ port, host: '127.0.0.1' });
  console.log(JSON.stringify({ ready: true, campaignId, gm, assistant, casey, dana }));
} else if (command === 'cleanup') {
  const [campaignId = ''] = args;
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
  const rows = await sql<{ object_key: string }[]>`
    select object_key from attachments where campaign_id = ${campaignId}::uuid`;
  for (const row of rows) await storage.delete(row.object_key).catch(() => undefined);
  await sql`delete from attachments where campaign_id = ${campaignId}::uuid`;
  await sql`delete from content_entity_relationships where campaign_id = ${campaignId}::uuid`;
  await sql`delete from content_personal_notes where campaign_id = ${campaignId}::uuid`;
  await sql`delete from content_entities where campaign_id = ${campaignId}::uuid`;
  await sql`delete from sync_long_text_holds where campaign_id = ${campaignId}::uuid`;
  await sql`delete from dice_rolls where campaign_id = ${campaignId}::uuid`;
  await sql.end({ timeout: 1 });
} else {
  throw new Error('usage: content-api-server.ts serve <port> | cleanup <campaignId>');
}
