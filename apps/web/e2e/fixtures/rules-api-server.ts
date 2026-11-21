import { FIXTURE_SYSTEM_PACKAGE } from '@rpg/fixtures';
import { INSTALLED_SYSTEM_PACKAGES } from '@rpg/installed-systems';
import type { SystemPackage } from '@rpg/systems';
import postgres from 'postgres';
import { buildRuntimeApp } from '../../../api/src/runtime.ts';

/**
 * Bun helper for `rules.e2e.ts`: the real API composition root with its default catalog, a GM and a player joined to
 * a campaign pinned to the first catalog package that claims `integrated_rules` (whichever it is: the test reads
 * section names from the declaration, as the library does). `cleanup <campaignId>` removes the run's rows.
 */

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required');
const API_ORIGIN = 'https://table.invalid';
const [command, ...args] = process.argv.slice(2);

if (command === 'serve') {
  const port = Number(args[0] ?? '4196');
  const system = [
    FIXTURE_SYSTEM_PACKAGE,
    ...(INSTALLED_SYSTEM_PACKAGES as readonly SystemPackage[]),
  ].find((candidate) => candidate.capabilities.includes('integrated_rules'));
  if (system === undefined) throw new Error('no catalog package integrates rules text');
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
      username: `${name}_${suffix}`,
    };
  };
  const gm = await signUp('gm_rules');
  const casey = await signUp('casey_rules');
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
      name: 'Rules at the table',
      description: '',
    },
  });
  if (created.statusCode !== 201) throw new Error(`campaign create failed: ${created.body}`);
  const invited = await app.inject({
    method: 'POST',
    url: `/campaigns/${campaignId}/invitations`,
    headers: { cookie: gm.cookie, origin: API_ORIGIN },
    payload: { targetRole: 'player' },
  });
  const accepted = await app.inject({
    method: 'POST',
    url: `/invitations/${invited.json().token}/accept`,
    headers: { cookie: casey.cookie, origin: API_ORIGIN },
  });
  if (accepted.statusCode !== 200) throw new Error(`accept failed: ${accepted.statusCode}`);
  await app.listen({ port, host: '127.0.0.1' });
  console.log(
    JSON.stringify({ ready: true, campaignId, gm, casey, sections: system.rules.sections }),
  );
} else if (command === 'marks') {
  // The authority's rows for one user, so the test sees what reached it.
  const [campaignId = '', userId = ''] = args;
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
  const rows = await sql`select section_id, bookmarked from rules_section_marks
    where campaign_id = ${campaignId} and user_id = ${userId} order by section_id`;
  console.log(JSON.stringify(rows.map((row) => ({ ...row }))));
  await sql.end({ timeout: 1 });
} else if (command === 'cleanup') {
  const [campaignId = ''] = args;
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
  for (const table of [
    'rules_section_marks',
    'campaign_sessions',
    'session_log_entries',
    'session_gm_notes',
    'sync_mutation_receipts',
  ]) {
    await sql.unsafe(`delete from ${table} where campaign_id = $1::uuid`, [campaignId]);
  }
  await sql.end({ timeout: 1 });
} else {
  throw new Error(
    'usage: rules-api-server.ts serve <port> | marks <campaignId> <userId> | cleanup <id>',
  );
}
