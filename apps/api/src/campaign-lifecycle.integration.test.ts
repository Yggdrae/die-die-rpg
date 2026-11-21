import { afterAll, describe, expect, test } from 'bun:test';
import type { SystemDefinition } from '@rpg/campaigns';
import { FIXTURE_SYSTEM_DEFINITION } from '@rpg/fixtures';
import postgres from 'postgres';
import { buildRuntimeApp } from './runtime.ts';

/**
 * Feature 02 acceptance flows through the real composition root (`buildRuntimeApp`) over
 * HTTP and PostgreSQL: creation, authorization, version pinning, deletion, and context.
 * Raw SQL is used only to observe persistence (tombstone retained, nothing leaked).
 * Skipped when no database is reachable, like the other integration suites.
 */

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const origin = 'https://table.invalid';
const sql = databaseUrl === undefined ? undefined : postgres(databaseUrl, { max: 2 });
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

const OLD = FIXTURE_SYSTEM_DEFINITION;
const NEWER: SystemDefinition = {
  ...OLD,
  summary: { ...OLD.summary, ref: { ...OLD.summary.ref, version: '0.2.0' } },
};

describe.skipIf(!available)('campaign lifecycle acceptance (runtime + PostgreSQL)', () => {
  test('creation, authorization, pin update, membership loss, and tombstone', async () => {
    if (sql === undefined || databaseUrl === undefined) return;
    const app = buildRuntimeApp({
      databaseUrl,
      allowedOrigin: origin,
      production: false,
      powerSyncEndpoint: 'http://localhost:8080',
      powerSyncJwtSecret: 'ZGV2ZWxvcG1lbnQtb25seS1wb3dlcnN5bmMta2V5LTMyIQ',
      systems: [OLD, NEWER],
    });
    try {
      const suffix = crypto.randomUUID().slice(0, 8);
      type Session = { cookie: string; userId: string };
      const signUp = async (name: string): Promise<Session> => {
        const response = await app.inject({
          method: 'POST',
          url: '/auth/accounts',
          payload: { username: `${name}_${suffix}`, password: 'correct horse battery staple' },
        });
        expect(response.statusCode).toBe(200);
        const raw = response.headers['set-cookie'];
        const header = Array.isArray(raw) ? raw[0] : raw;
        const cookie = (header ?? '').split(';')[0] ?? '';
        expect(cookie).toStartWith('rpg_session=');
        return { cookie, userId: response.json().user.id };
      };
      const call = (
        who: Session | undefined,
        method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
        url: string,
        payload?: unknown,
      ) =>
        app.inject({
          method,
          url,
          headers: {
            ...(who === undefined ? {} : { cookie: who.cookie }),
            ...(method === 'GET' ? {} : { origin }),
          },
          ...(payload === undefined ? {} : { payload: payload as object }),
        });
      const count = async (table: 'campaigns' | 'campaign_system_pins', id: string) => {
        const [row] =
          table === 'campaigns'
            ? await sql`select count(*)::int as n from campaigns where id = ${id}`
            : await sql`select count(*)::int as n from campaign_system_pins where campaign_id = ${id}`;
        return row?.n as number;
      };

      const owner = await signUp('owner');
      const player = await signUp('player');
      const outsider = await signUp('outsider');

      // System selection renders from summaries only.
      const systems = await call(owner, 'GET', '/systems');
      expect(systems.statusCode).toBe(200);
      expect(systems.json().map((s: { ref: { version: string } }) => s.ref.version)).toEqual([
        '0.1.0',
      ]);

      // Creation: invalid wizard output persists nothing and is retryable.
      const id = crypto.randomUUID();
      const input = {
        id,
        system: OLD.summary.ref,
        gameMode: 'standard',
        options: {},
        moduleIds: [],
        name: 'Road Game',
        description: 'A long road.',
      };
      expect((await call(owner, 'POST', '/campaigns', { ...input, name: '' })).statusCode).toBe(
        400,
      );
      expect(
        (await call(owner, 'POST', '/campaigns', { ...input, gameMode: 'nope' })).statusCode,
      ).toBe(400);
      expect(await count('campaigns', id)).toBe(0);
      expect(await count('campaign_system_pins', id)).toBe(0);

      const created = await call(owner, 'POST', '/campaigns', input);
      expect(created.statusCode).toBe(201);
      expect(created.json().system).toEqual(OLD.summary.ref);
      // Retry of the same aggregate is idempotent: one campaign.
      expect((await call(owner, 'POST', '/campaigns', input)).statusCode).toBe(201);
      expect(await count('campaigns', id)).toBe(1);
      // Exactly one active owner, and it is the creator.
      const owners = await sql`
        select user_id from identity_campaign_memberships
        where campaign_id = ${id} and role = 'owner' and removed_at is null`;
      expect(owners.map((row) => row.user_id)).toEqual([owner.userId]);

      // Listing and context: members only.
      const ownerList = await call(owner, 'GET', '/campaigns');
      expect(ownerList.json().map((c: { id: string }) => c.id)).toContain(id);
      expect((await call(outsider, 'GET', '/campaigns')).json() as unknown).toEqual([]);

      // Non-member and missing campaign are indistinguishable.
      const denied = await call(outsider, 'GET', `/campaigns/${id}`);
      const missing = await call(outsider, 'GET', `/campaigns/${crypto.randomUUID()}`);
      expect(denied.statusCode).toBe(404);
      expect(denied.json()).toEqual(missing.json());
      expect(denied.json().code).toBe('not_found_or_forbidden');
      for (const [method, suffixPath, payload] of [
        ['PATCH', '', { name: 'x', description: '', expectedVersion: 1 }],
        ['DELETE', '', { expectedVersion: 1 }],
        ['GET', '/system-update', undefined],
        ['POST', '/system-update', { targetVersion: '0.2.0', expectedVersion: 1 }],
      ] as const) {
        const response = await call(outsider, method, `/campaigns/${id}${suffixPath}`, payload);
        expect([response.statusCode, response.json().code]).toEqual([
          404,
          'not_found_or_forbidden',
        ]);
      }

      // Invite the player.
      const invited = await call(owner, 'POST', `/campaigns/${id}/invitations`, {
        targetRole: 'player',
      });
      expect(invited.statusCode).toBe(201);
      const accepted = await call(player, 'POST', `/invitations/${invited.json().token}/accept`);
      expect(accepted.statusCode).toBe(200);
      expect((await call(player, 'GET', `/campaigns/${id}`)).statusCode).toBe(200);

      // A player changes nothing; the denial is the shared ApiError.
      const before = (await call(owner, 'GET', `/campaigns/${id}`)).json();
      for (const [method, suffixPath, payload] of [
        ['PATCH', '', { name: 'Hijacked', description: '', expectedVersion: before.version }],
        ['POST', '/system-update', { targetVersion: '0.2.0', expectedVersion: before.version }],
        ['DELETE', '', { expectedVersion: before.version }],
      ] as const) {
        const response = await call(player, method, `/campaigns/${id}${suffixPath}`, payload);
        expect([response.statusCode, response.json().code]).toEqual([
          404,
          'not_found_or_forbidden',
        ]);
      }
      expect((await call(owner, 'GET', `/campaigns/${id}`)).json()).toEqual(before);

      // A newer version is offered, never applied.
      const review = await call(owner, 'GET', `/campaigns/${id}/system-update`);
      expect(review.json() as unknown).toEqual({
        current: OLD.summary.ref,
        target: NEWER.summary.ref,
      });
      expect((await call(owner, 'GET', `/campaigns/${id}`)).json().system).toEqual(OLD.summary.ref);

      // Editing details leaves the pin untouched.
      const edited = await call(owner, 'PATCH', `/campaigns/${id}`, {
        name: 'Road Game II',
        description: 'Changed.',
        expectedVersion: before.version,
      });
      expect(edited.statusCode).toBe(200);
      expect(edited.json()).toMatchObject({ name: 'Road Game II', system: OLD.summary.ref });

      // Explicit update is the only writer of the pin. Two concurrent submits at the same
      // record version: exactly one applies, the other is a version conflict.
      const updateBody = { targetVersion: '0.2.0', expectedVersion: edited.json().version };
      const submissions = await Promise.all([
        call(owner, 'POST', `/campaigns/${id}/system-update`, updateBody),
        call(owner, 'POST', `/campaigns/${id}/system-update`, updateBody),
      ]);
      expect(submissions.map((response) => response.statusCode).sort()).toEqual([200, 409]);
      const updated = submissions.find((response) => response.statusCode === 200);
      const stale = submissions.find((response) => response.statusCode === 409);
      if (updated === undefined || stale === undefined) throw new Error('unreachable');
      expect(updated.json().system).toEqual(NEWER.summary.ref);
      expect(stale.json().code).toBe('version_conflict');
      expect((await call(player, 'GET', `/campaigns/${id}`)).json().system).toEqual(
        NEWER.summary.ref,
      );
      const unknown = await call(owner, 'POST', `/campaigns/${id}/system-update`, {
        targetVersion: '9.9.9',
        expectedVersion: updated.json().version,
      });
      expect(unknown.statusCode).toBeGreaterThanOrEqual(400);
      expect((await call(owner, 'GET', `/campaigns/${id}`)).json().system).toEqual(
        NEWER.summary.ref,
      );

      // An unowned settings namespace is rejected and creates nothing.
      const setting = await call(owner, 'PUT', `/campaigns/${id}/settings/unowned.namespace`, {
        value: { enabled: true },
        expectedVersion: null,
      });
      expect(setting.statusCode).toBeGreaterThanOrEqual(400);
      const [settingRow] = await sql`
        select count(*)::int as n from campaign_settings
        where campaign_id = ${id} and namespace = 'unowned.namespace'`;
      expect(settingRow?.n).toBe(0);

      // Losing membership removes the campaign from the list and denies direct reads.
      const removed = await call(owner, 'DELETE', `/campaigns/${id}/members/${player.userId}`);
      expect(removed.statusCode).toBe(204);
      expect((await call(player, 'GET', '/campaigns')).json() as unknown).toEqual([]);
      expect((await call(player, 'GET', `/campaigns/${id}`)).statusCode).toBe(404);

      // Deletion is a tombstone, not a removal.
      const current = (await call(owner, 'GET', `/campaigns/${id}`)).json();
      const deleted = await call(owner, 'DELETE', `/campaigns/${id}`, {
        expectedVersion: current.version,
      });
      expect(deleted.statusCode).toBe(204);
      expect((await call(owner, 'GET', '/campaigns')).json() as unknown).toEqual([]);
      const gone = await call(owner, 'GET', `/campaigns/${id}`);
      expect([gone.statusCode, gone.json().code]).toEqual([404, 'not_found_or_forbidden']);
      const [tombstone] = await sql`select deleted_at from campaigns where id = ${id}`;
      expect(tombstone?.deleted_at).not.toBeNull();
      expect(await count('campaign_system_pins', id)).toBe(1);
    } finally {
      await app.close();
    }
  });
});
