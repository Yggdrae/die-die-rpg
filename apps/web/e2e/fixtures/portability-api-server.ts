import { FIXTURE_SYSTEM_DEFINITION } from '@rpg/fixtures';
import postgres from 'postgres';
import { buildRuntimeApp } from '../../../api/src/runtime.ts';

/**
 * Bun helper for `portability-import.e2e.ts` (Playwright runs under Node; Fastify and PostgreSQL
 * run here). `serve <port>` starts the real API composition root with the fixture system, signs
 * up a GM and an importer, creates the GM's campaign, and prints one JSON line with their session
 * cookies. `owner <port> <cookie> <campaignId>` prints the importer's view of a campaign and its
 * members. `cleanup <gmId> <importerId>` removes the job rows the run created.
 */

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required');
export const API_ORIGIN = 'https://table.invalid';
const [command, ...args] = process.argv.slice(2);

if (command === 'serve') {
  const port = Number(args[0] ?? '4187');
  const app = buildRuntimeApp({
    databaseUrl,
    allowedOrigin: API_ORIGIN,
    production: false,
    powerSyncEndpoint: 'http://localhost:8080',
    powerSyncJwtSecret: 'ZGV2ZWxvcG1lbnQtb25seS1wb3dlcnN5bmMta2V5LTMyIQ',
    version: 'e2e',
    logger: false,
    systems: [FIXTURE_SYSTEM_DEFINITION],
  });
  const suffix = crypto.randomUUID().slice(0, 8);
  const signUp = async (name: string) => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/accounts',
      payload: { username: `${name}_${suffix}`, password: 'correct horse battery staple' },
    });
    const raw = response.headers['set-cookie'];
    const header = Array.isArray(raw) ? raw[0] : raw;
    return {
      cookie: (header ?? '').split(';')[0] ?? '',
      userId: response.json().user.id as string,
    };
  };
  const gm = await signUp('gm_ana');
  const importer = await signUp('importer');
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
      name: 'Ashen Road',
      description: 'The caravan never reached the pass.',
    },
  });
  if (created.statusCode !== 201) throw new Error(`campaign create failed: ${created.statusCode}`);
  await app.listen({ port, host: '127.0.0.1' });
  console.log(JSON.stringify({ ready: true, campaignId, gm, importer }));
} else if (command === 'cleanup') {
  const [gmId, importerId] = args;
  const sql = postgres(databaseUrl, { max: 1 });
  await sql`delete from export_jobs where requested_by = any(${[gmId, importerId]}::uuid[])`;
  await sql`delete from import_preserved_chunks where campaign_id in (
    select campaign_id from import_jobs where requested_by = ${importerId ?? ''} and campaign_id is not null)`;
  await sql`delete from import_jobs where requested_by = ${importerId ?? ''}`;
  await sql.end({ timeout: 1 });
} else {
  throw new Error('usage: portability-api-server.ts serve <port> | cleanup <gmId> <importerId>');
}
