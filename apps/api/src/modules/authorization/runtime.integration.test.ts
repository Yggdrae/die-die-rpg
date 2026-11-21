import { afterAll, describe, expect, test } from 'bun:test';
import { FIXTURE_SYSTEM_DEFINITION } from '@rpg/fixtures';
import postgres from 'postgres';
import { buildRuntimeApp } from '../../runtime.ts';

/**
 * Composition-root check (feature 04 task 04): the runtime wires the visibility route and the
 * content-route inventory, startup passes, and no production class is reveal-capable yet, so every
 * class answers with the same safe denial. Skipped when no database is reachable.
 */

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const origin = 'https://table.invalid';
const sql = databaseUrl === undefined ? undefined : postgres(databaseUrl, { max: 1 });
const available = await (async () => {
  if (sql === undefined) return false;
  try {
    await sql`select 1`;
    return true;
  } catch {
    return false;
  }
})();
afterAll(async () => sql?.end({ timeout: 1 }));

describe.skipIf(!available)('visibility route in the runtime composition', () => {
  test('starts with the inventory satisfied and denies every class safely', async () => {
    if (databaseUrl === undefined) return;
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
      const account = await app.inject({
        method: 'POST',
        url: '/auth/accounts',
        payload: { username: `vis_${suffix}`, password: 'correct horse battery staple' },
      });
      expect(account.statusCode).toBe(200);
      const raw = account.headers['set-cookie'];
      const cookie = ((Array.isArray(raw) ? raw[0] : raw) ?? '').split(';')[0] ?? '';
      const campaignId = crypto.randomUUID();
      const created = await app.inject({
        method: 'POST',
        url: '/campaigns',
        headers: { cookie, origin },
        payload: {
          id: campaignId,
          system: FIXTURE_SYSTEM_DEFINITION.summary.ref,
          gameMode: 'standard',
          options: {},
          moduleIds: [],
          name: 'Visibility',
          description: '',
        },
      });
      expect(created.statusCode).toBe(201);

      const body = {
        operation: 'reveal',
        target: { mode: 'everyone' },
        expectedVersion: 1,
      };
      const send = (resourceClass: string, headers: Record<string, string>) =>
        app.inject({
          method: 'PATCH',
          url: `/campaigns/${campaignId}/resources/${resourceClass}/${crypto.randomUUID()}/visibility`,
          headers,
          payload: body,
        });
      const owner = { cookie, origin };
      const registered = await send('campaign', owner);
      const unknown = await send('no_such_class', owner);
      const anonymous = await send('campaign', { origin });

      expect(registered.statusCode).toBe(404);
      expect(registered.body).toBe(unknown.body);
      expect(JSON.parse(registered.body)).toEqual({
        code: 'not_found_or_forbidden',
        message: 'Not found.',
      });
      expect(anonymous.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  test('a long-text hold needs update on the campaign record it names', async () => {
    if (databaseUrl === undefined) return;
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
        return ((Array.isArray(raw) ? raw[0] : raw) ?? '').split(';')[0] ?? '';
      };
      const owner = await signUp(`hold_${suffix}`);
      const stranger = await signUp(`hold_x_${suffix}`);
      const campaignId = crypto.randomUUID();
      const created = await app.inject({
        method: 'POST',
        url: '/campaigns',
        headers: { cookie: owner, origin },
        payload: {
          id: campaignId,
          system: FIXTURE_SYSTEM_DEFINITION.summary.ref,
          gameMode: 'standard',
          options: {},
          moduleIds: [],
          name: 'Holds',
          description: '',
        },
      });
      expect(created.statusCode).toBe(201);
      const acquire = (cookie: string, resourceClass: string, recordId: string) =>
        app.inject({
          method: 'POST',
          url: `/sync/holds/${campaignId}/acquire`,
          headers: { cookie, origin },
          payload: { resourceClass, recordId, fieldPath: 'description' },
        });

      const held = await acquire(owner, 'campaign', campaignId);
      expect(held.statusCode).toBe(200);
      expect(held.json()).toMatchObject({ acquired: true });
      const otherRecord = await acquire(owner, 'campaign', crypto.randomUUID());
      const unknownClass = await acquire(owner, 'no_such_class', campaignId);
      const nonMember = await acquire(stranger, 'campaign', campaignId);
      for (const denied of [otherRecord, unknownClass, nonMember]) {
        expect(denied.statusCode).toBe(404);
        expect(JSON.parse(denied.body)).toEqual({
          code: 'not_found_or_forbidden',
          message: 'Not found.',
        });
      }
    } finally {
      await app.close();
    }
  });
});
