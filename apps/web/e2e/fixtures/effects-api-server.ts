import type { EffectTargetAdapter } from '@rpg/actions/postgres';
import { visibilityFromColumns } from '@rpg/authorization';
import { FIXTURE_SYSTEM_DEFINITION } from '@rpg/fixtures';
import { sql as drizzleSql } from 'drizzle-orm';
import postgres from 'postgres';
import { buildRuntimeApp } from '../../../api/src/runtime.ts';

/**
 * Bun helper for `effects.e2e.ts`. `serve <port>` starts the real API composition root with a probe target
 * standing in for feature 15's characters (feature 11 D-13), signs up a GM and two players, joins them through
 * the identity routes, seeds one public and one GM-only target, and prints one JSON line with their session
 * cookies. `cleanup <campaignId>` removes the run's rows.
 */

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required');
const API_ORIGIN = 'https://table.invalid';
const [command, ...args] = process.argv.slice(2);
const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });

const PROBE: EffectTargetAdapter = {
  targetClass: 'campaign_entity',
  load: async (transaction, { campaignId, targetId }) => {
    const rows = (await transaction.execute(drizzleSql`
      select state, visibility_mode from effect_e2e_targets
      where id = ${targetId} and campaign_id = ${campaignId} for update`)) as unknown as {
      state: never;
      visibility_mode: string;
    }[];
    const [row] = rows;
    const visibility =
      row === undefined ? undefined : visibilityFromColumns(row.visibility_mode, []);
    if (row === undefined || visibility === undefined) return undefined;
    return {
      state: row.state,
      facts: {
        campaignId,
        resourceClass: 'campaign_entity',
        resourceId: targetId,
        visibility,
        version: 1,
      },
    };
  },
  save: async (transaction, { campaignId, targetId, state }) => {
    await transaction.execute(drizzleSql`
      update effect_e2e_targets set state = ${JSON.stringify(state)}::jsonb
      where id = ${targetId} and campaign_id = ${campaignId}`);
  },
};

if (command === 'serve') {
  const port = Number(args[0] ?? '4190');
  await sql`create table if not exists effect_e2e_targets (
    id uuid primary key, campaign_id uuid not null, state jsonb not null,
    visibility_mode text not null)`;
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
    effectTargets: [PROBE],
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
  const gm = await signUp('gm_fx');
  const casey = await signUp('casey_fx');
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
      name: 'Effect table',
      description: '',
    },
  });
  if (created.statusCode !== 201) throw new Error(`campaign create failed: ${created.statusCode}`);
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
  const state = {
    fields: {},
    resources: { hp: { current: 10 } },
    tracks: {},
    conditions: {},
    inventory: {},
    slots: {},
  };
  const shared = crypto.randomUUID();
  const hidden = crypto.randomUUID();
  await sql`insert into effect_e2e_targets (id, campaign_id, state, visibility_mode)
    values (${shared}, ${campaignId}, ${sql.json(state)}, 'everyone'),
           (${hidden}, ${campaignId}, ${sql.json(state)}, 'gm_only')`;
  await app.listen({ port, host: '127.0.0.1' });
  console.log(JSON.stringify({ ready: true, campaignId, gm, casey, shared, hidden }));
} else if (command === 'cleanup') {
  const [campaignId = ''] = args;
  await sql`delete from effect_applications where campaign_id = ${campaignId}::uuid`;
  await sql`delete from sync_mutation_receipts where campaign_id = ${campaignId}::uuid`;
  await sql`drop table if exists effect_e2e_targets`;
  await sql.end({ timeout: 1 });
} else {
  throw new Error('usage: effects-api-server.ts serve <port> | cleanup <campaignId>');
}
