import { INSTALLED_SYSTEM_PACKAGES } from '@rpg/installed-systems';
import type { SystemPackage } from '@rpg/systems';
import postgres from 'postgres';
import { buildRuntimeApp } from '../../../api/src/runtime.ts';

/**
 * Bun helper for `characters.e2e.ts`: the real API composition root with its default catalog, a GM and two
 * players joined to a campaign pinned to the first shipped package (whichever it is: the test reads the sheet
 * from the schema, as the product does). `cleanup <campaignId>` removes the run's rows.
 */

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required');
const API_ORIGIN = 'https://table.invalid';
const [command, ...args] = process.argv.slice(2);

if (command === 'serve') {
  const port = Number(args[0] ?? '4191');
  const system = INSTALLED_SYSTEM_PACKAGES[0] as SystemPackage;
  const app = buildRuntimeApp({
    databaseUrl,
    allowedOrigin: API_ORIGIN,
    production: false,
    powerSyncEndpoint: process.env.POWERSYNC_ENDPOINT ?? 'http://localhost:8080',
    powerSyncJwtSecret:
      process.env.POWERSYNC_JWT_SECRET ?? 'ZGV2ZWxvcG1lbnQtb25seS1wb3dlcnN5bmMta2V5LTMyIQ',
    version: 'e2e',
    logger: false,
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
    };
  };
  const gm = await signUp('gm_sheet');
  const casey = await signUp('casey_sheet');
  const dana = await signUp('dana_sheet');
  const campaignId = crypto.randomUUID();
  const created = await app.inject({
    method: 'POST',
    url: '/campaigns',
    headers: { cookie: gm.cookie, origin: API_ORIGIN },
    payload: {
      id: campaignId,
      system: system.manifest.ref,
      gameMode: system.gameModes[0]?.id,
      options: {},
      moduleIds: [],
      name: 'Sheet table',
      description: '',
    },
  });
  if (created.statusCode !== 201) throw new Error(`campaign create failed: ${created.body}`);
  for (const member of [casey, dana]) {
    const invited = await app.inject({
      method: 'POST',
      url: `/campaigns/${campaignId}/invitations`,
      headers: { cookie: gm.cookie, origin: API_ORIGIN },
      payload: { targetRole: 'player' },
    });
    const accepted = await app.inject({
      method: 'POST',
      url: `/invitations/${invited.json().token}/accept`,
      headers: { cookie: member.cookie, origin: API_ORIGIN },
    });
    if (accepted.statusCode !== 200) throw new Error(`accept failed: ${accepted.statusCode}`);
  }
  await app.listen({ port, host: '127.0.0.1' });
  console.log(JSON.stringify({ ready: true, campaignId, gm, casey, dana }));
} else if (command === 'cleanup') {
  const [campaignId = ''] = args;
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
  for (const table of [
    'effect_applications',
    'dice_rolls',
    'character_secrets',
    'characters',
    'sync_mutation_receipts',
  ]) {
    await sql.unsafe(`delete from ${table} where campaign_id = $1::uuid`, [campaignId]);
  }
  await sql.end({ timeout: 1 });
} else {
  throw new Error('usage: characters-api-server.ts serve <port> | cleanup <campaignId>');
}
