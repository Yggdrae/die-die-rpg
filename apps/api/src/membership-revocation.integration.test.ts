import { afterAll, describe, expect, test } from 'bun:test';
import type { AuditEvent, CampaignAccessRevoked } from '@rpg/contracts';
import { FIXTURE_SYSTEM_DEFINITION } from '@rpg/fixtures';
import postgres from 'postgres';
import { buildRuntimeApp } from './runtime.ts';

/**
 * Feature 01 task 12 through the real composition root: audit and revocation delivery both
 * fail after commit, yet the membership change stands and every server path denies the
 * removed member. Skipped when no database is reachable.
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

describe.skipIf(!available)('membership revocation boundary (runtime + PostgreSQL)', () => {
  test('failed audit and revocation delivery never restore access', async () => {
    if (sql === undefined || databaseUrl === undefined) return;
    const audits: Omit<AuditEvent, 'id'>[] = [];
    const signals: CampaignAccessRevoked[] = [];
    const app = buildRuntimeApp({
      databaseUrl,
      allowedOrigin: origin,
      production: false,
      powerSyncEndpoint: 'http://localhost:8080',
      powerSyncJwtSecret: 'ZGV2ZWxvcG1lbnQtb25seS1wb3dlcnN5bmMta2V5LTMyIQ',
      integrations: {
        audit: {
          record: async (event) => {
            audits.push(event);
            throw new Error('audit store down');
          },
        },
        revocations: {
          publish: async (event) => {
            signals.push(event);
            throw new Error('sync delivery down');
          },
        },
      },
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
        return { cookie: (header ?? '').split(';')[0] ?? '', userId: response.json().user.id };
      };
      const call = (
        who: Session,
        method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
        url: string,
        payload?: unknown,
      ) =>
        app.inject({
          method,
          url,
          headers: { cookie: who.cookie, ...(method === 'GET' ? {} : { origin }) },
          ...(payload === undefined ? {} : { payload: payload as object }),
        });

      const owner = await signUp('rev_owner');
      const player = await signUp('rev_player');
      const gm = await signUp('rev_gm');
      const id = crypto.randomUUID();
      const created = await call(owner, 'POST', '/campaigns', {
        id,
        system: FIXTURE_SYSTEM_DEFINITION.summary.ref,
        gameMode: 'standard',
        options: {},
        moduleIds: [],
        name: 'Revocation Game',
        description: '',
      });
      expect(created.statusCode).toBe(201);

      for (const [who, targetRole] of [
        [player, 'player'],
        [gm, 'gm'],
      ] as const) {
        const invited = await call(owner, 'POST', `/campaigns/${id}/invitations`, { targetRole });
        expect(invited.statusCode).toBe(201);
        const accepted = await call(who, 'POST', `/invitations/${invited.json().token}/accept`);
        expect(accepted.statusCode).toBe(200);
        const token = invited.json().token as string;
        expect(JSON.stringify(audits)).not.toContain(token);
      }
      expect(
        audits
          .filter((event) => event.action === 'membership.created')
          .map((event) => event.targetId),
      ).toEqual([player.userId, gm.userId]);
      expect((await call(player, 'GET', `/sync/bootstrap/${id}`)).statusCode).toBe(200);

      // Removal commits even though both post-commit integrations throw.
      const removed = await call(owner, 'DELETE', `/campaigns/${id}/members/${player.userId}`);
      expect(removed.statusCode).toBe(204);
      const [row] = await sql`
        select removed_at, version::int as version from identity_campaign_memberships
        where campaign_id = ${id} and user_id = ${player.userId}`;
      expect(row?.removed_at).not.toBeNull();
      expect(signals).toEqual([
        expect.objectContaining({
          campaignId: id,
          userId: player.userId,
          reason: 'removed',
          membershipVersion: row?.version,
        }),
      ]);
      expect(audits.at(-1)).toMatchObject({
        action: 'membership.removed',
        targetId: player.userId,
      });

      // Undelivered notification does not matter: every server path denies the removed member.
      expect((await call(player, 'GET', `/campaigns/${id}`)).statusCode).toBe(404);
      expect((await call(player, 'GET', '/campaigns')).json<unknown>()).toEqual([]);
      expect((await call(player, 'GET', `/sync/bootstrap/${id}`)).statusCode).toBe(404);
      expect((await call(player, 'GET', `/campaigns/${id}/members`)).statusCode).toBe(404);
      const upload = await call(player, 'POST', '/sync/mutations', {
        campaignId: id,
        replicaId: crypto.randomUUID(),
        mutations: [
          {
            mutationId: crypto.randomUUID(),
            campaignId: id,
            featureId: 'campaigns',
            tableName: 'campaigns',
            recordId: id,
            operation: 'update',
            expectedVersion: 1,
            payload: { name: 'Hijacked' },
            causalSequence: 1,
            state: 'pending',
            attemptCount: 0,
            recordedAt: '2026-08-31T10:00:00Z',
          },
        ],
      });
      expect(upload.json().outcomes[0]).toMatchObject({
        status: 'error',
        code: 'not_found_or_forbidden',
      });

      // Role change: the new role is authoritative immediately despite failed delivery.
      const changed = await call(owner, 'PATCH', `/campaigns/${id}/members/${gm.userId}/role`, {
        role: 'player',
      });
      expect(changed.statusCode).toBe(200);
      expect(changed.json()).toMatchObject({ role: 'player', version: 2 });
      expect(signals.at(-1)).toMatchObject({
        userId: gm.userId,
        reason: 'role_changed',
        membershipVersion: 2,
      });
      const [gmRow] = await sql`
        select role from identity_campaign_memberships
        where campaign_id = ${id} and user_id = ${gm.userId}`;
      expect(gmRow?.role).toBe('player');
    } finally {
      await app.close();
    }
  });

  test('default durable publisher records delivery and revokes the removed member subscriptions', async () => {
    if (sql === undefined || databaseUrl === undefined) return;
    const app = buildRuntimeApp({
      databaseUrl,
      allowedOrigin: origin,
      production: false,
      powerSyncEndpoint: 'http://localhost:8080',
      powerSyncJwtSecret: 'ZGV2ZWxvcG1lbnQtb25seS1wb3dlcnN5bmMta2V5LTMyIQ',
      logger: false,
      integrations: { audit: { record: async () => undefined } },
    });
    const id = crypto.randomUUID();
    try {
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
      const send = (
        who: { cookie: string },
        method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
        url: string,
        payload?: object,
      ) =>
        app.inject({
          method,
          url,
          headers: { cookie: who.cookie, ...(method === 'GET' ? {} : { origin }) },
          ...(payload === undefined ? {} : { payload }),
        });
      const owner = await signUp('drv_owner');
      const player = await signUp('drv_player');
      const created = await send(owner, 'POST', '/campaigns', {
        id,
        system: FIXTURE_SYSTEM_DEFINITION.summary.ref,
        gameMode: 'standard',
        options: {},
        moduleIds: [],
        name: 'Delivery Game',
        description: '',
      });
      expect(created.statusCode).toBe(201);
      const invited = await send(owner, 'POST', `/campaigns/${id}/invitations`, {
        targetRole: 'gm',
      });
      await send(player, 'POST', `/invitations/${invited.json().token}/accept`);
      const replicaId = crypto.randomUUID();
      const bootstrap = await send(player, 'GET', `/sync/bootstrap/${id}?replicaId=${replicaId}`);
      expect(bootstrap.json().replicaId).toBe(replicaId);

      const members = `/campaigns/${id}/members/${player.userId}`;
      expect((await send(owner, 'PATCH', `${members}/role`, { role: 'player' })).statusCode).toBe(
        200,
      );
      const [afterRoleChange] = await sql`
        select revoked_at from sync_replica_subscriptions
        where campaign_id = ${id} and replica_id = ${replicaId}`;
      expect(afterRoleChange?.revoked_at).toBeNull();
      expect((await send(owner, 'DELETE', members)).statusCode).toBe(204);

      const deliveries = await sql`
        select reason, state, attempt_count, membership_version::int as version
        from sync_access_revocations where campaign_id = ${id} and user_id = ${player.userId}
        order by membership_version`;
      expect([...deliveries]).toEqual([
        { reason: 'role_changed', state: 'delivered', attempt_count: 0, version: 2 },
        { reason: 'removed', state: 'delivered', attempt_count: 0, version: 3 },
      ]);
      const [subscription] = await sql`
        select revoked_at from sync_replica_subscriptions
        where campaign_id = ${id} and replica_id = ${replicaId}`;
      expect(subscription?.revoked_at).not.toBeNull();
      const denied = await send(player, 'GET', `/sync/bootstrap/${id}?replicaId=${replicaId}`);
      expect(denied.statusCode).toBe(404);
    } finally {
      await sql`delete from sync_access_revocations where campaign_id = ${id}`;
      await sql`delete from sync_replica_subscriptions where campaign_id = ${id}`;
      await app.close();
    }
  });
});
