import { afterAll, describe, expect, test } from 'bun:test';
import { FIXTURE_SYSTEM_DEFINITION } from '@rpg/fixtures';
import postgres from 'postgres';
import { membershipAuditOriginId } from './modules/audit/composition.ts';
import { runOperatorRecoveryCommand } from './modules/identity/operator-cli.ts';
import { buildRuntimeApp } from './runtime.ts';

/**
 * Feature 06 tasks 01/02 through the real composition root: identity and campaign events
 * reach the durable campaign store, operator recovery reaches the account store, and no
 * event lands in the GM-private store. Skipped when no migrated database is reachable.
 */

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const origin = 'https://table.invalid';
const sql = databaseUrl === undefined ? undefined : postgres(databaseUrl, { max: 2 });
const available = await (async () => {
  if (sql === undefined) return false;
  try {
    await sql`select 1 from audit_campaign_events limit 1`;
    return true;
  } catch {
    return false;
  }
})();
afterAll(async () => sql?.end({ timeout: 1 }));

describe.skipIf(!available)('durable audit runtime (PostgreSQL)', () => {
  test('membership, campaign, and recovery events are durably recorded', async () => {
    if (sql === undefined || databaseUrl === undefined) return;
    const lines: string[] = [];
    const app = buildRuntimeApp({
      databaseUrl,
      allowedOrigin: origin,
      production: false,
      powerSyncEndpoint: 'http://localhost:8080',
      powerSyncJwtSecret: 'ZGV2ZWxvcG1lbnQtb25seS1wb3dlcnN5bmMta2V5LTMyIQ',
      logger: { stream: { write: (line: string) => lines.push(line) } },
    });
    try {
      const suffix = crypto.randomUUID().slice(0, 8);
      const signUp = async (name: string) => {
        const response = await app.inject({
          method: 'POST',
          url: '/auth/accounts',
          payload: { username: `${name}_${suffix}`, password: 'correct horse battery staple' },
        });
        expect(response.statusCode).toBe(200);
        const raw = response.headers['set-cookie'];
        const header = Array.isArray(raw) ? raw[0] : raw;
        return {
          cookie: (header ?? '').split(';')[0] ?? '',
          userId: response.json().user.id as string,
          username: `${name}_${suffix}`,
        };
      };
      type Session = Awaited<ReturnType<typeof signUp>>;
      const call = (
        who: Session,
        method: 'POST' | 'PATCH' | 'DELETE',
        url: string,
        payload?: object,
      ) => app.inject({ method, url, headers: { cookie: who.cookie, origin }, payload });

      const owner = await signUp('audit_owner');
      const player = await signUp('audit_player');
      const id = crypto.randomUUID();
      const created = await call(owner, 'POST', '/campaigns', {
        id,
        system: FIXTURE_SYSTEM_DEFINITION.summary.ref,
        gameMode: 'standard',
        options: {},
        moduleIds: [],
        name: 'Audit Game',
        description: '',
      });
      expect(created.statusCode).toBe(201);
      const invited = await call(owner, 'POST', `/campaigns/${id}/invitations`, {
        targetRole: 'player',
      });
      const token = invited.json().token as string;
      expect((await call(player, 'POST', `/invitations/${token}/accept`)).statusCode).toBe(200);
      expect(
        (await call(owner, 'DELETE', `/campaigns/${id}/members/${player.userId}`)).statusCode,
      ).toBe(204);

      // Public campaign boundary: details edit and soft delete reach the durable store too.
      const edited = await call(owner, 'PATCH', `/campaigns/${id}`, {
        name: 'Audit Game Renamed',
        description: '',
        expectedVersion: created.json().version,
      });
      expect(edited.statusCode).toBe(200);
      expect(
        (
          await call(owner, 'DELETE', `/campaigns/${id}`, {
            expectedVersion: edited.json().version,
          })
        ).statusCode,
      ).toBe(204);

      const events = await sql<{ action: string; campaign_sequence: string; target_id: string }[]>`
        select action, campaign_sequence, target_id from audit_campaign_events
        where campaign_id = ${id} order by campaign_sequence`;
      expect(events.map((row) => row.action)).toEqual([
        'campaign.created',
        'membership.created',
        'membership.removed',
        'campaign.details_updated',
        'campaign.deleted',
      ]);
      expect(events.map((row) => Number(row.campaign_sequence))).toEqual([1, 2, 3, 4, 5]);
      // Origin IDs derive from (campaign, user, membership version, action): a replay after
      // integrationDegraded addresses the same row instead of recording a second event.
      const origins = await sql<{ action: string; origin_mutation_id: string }[]>`
        select action, origin_mutation_id from audit_campaign_events
        where campaign_id = ${id} and action like 'membership.%' order by campaign_sequence`;
      expect([...origins]).toEqual([
        {
          action: 'membership.created',
          origin_mutation_id: membershipAuditOriginId({
            campaignId: id,
            userId: player.userId,
            membershipVersion: 1,
            action: 'membership.created',
          }),
        },
        {
          action: 'membership.removed',
          origin_mutation_id: membershipAuditOriginId({
            campaignId: id,
            userId: player.userId,
            membershipVersion: 2,
            action: 'membership.removed',
          }),
        },
      ]);
      const [privateCount] = await sql<{ n: number }[]>`
        select count(*)::int as n from audit_private_events where campaign_id = ${id}`;
      expect(privateCount?.n).toBe(0);
      expect(lines.join('\n')).not.toContain(token);

      const stdout: string[] = [];
      const stderr: string[] = [];
      const exitCode = await runOperatorRecoveryCommand({
        databaseUrl,
        args: ['--username', player.username, '--operator-reference', 'host:audit-test'],
        output: { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) },
      });
      expect(exitCode).toBe(0);
      const recovery = await sql<{ actor_reference: string; target_type: string }[]>`
        select actor_reference, target_type from audit_account_events
        where subject_user_id = ${player.userId} and action = 'recovery.issued'`;
      expect([...recovery]).toEqual([
        { actor_reference: 'host:audit-test', target_type: 'recovery_token' },
      ]);
      expect(stderr.join('\n')).not.toContain(stdout[0] ?? 'missing');
      expect(stderr.join('\n')).not.toContain('Audit ');
    } finally {
      await app.close();
    }
  });

  test('synced mutations are audited once under their mutation ID, with no payload in logs', async () => {
    if (sql === undefined || databaseUrl === undefined) return;
    const lines: string[] = [];
    const app = buildRuntimeApp({
      databaseUrl,
      allowedOrigin: origin,
      production: false,
      powerSyncEndpoint: 'http://localhost:8080',
      powerSyncJwtSecret: 'ZGV2ZWxvcG1lbnQtb25seS1wb3dlcnN5bmMta2V5LTMyIQ',
      logger: { stream: { write: (line: string) => lines.push(line) } },
    });
    try {
      const suffix = crypto.randomUUID().slice(0, 8);
      const signedUp = await app.inject({
        method: 'POST',
        url: '/auth/accounts',
        payload: { username: `sync_audit_${suffix}`, password: 'correct horse battery staple' },
      });
      expect(signedUp.statusCode).toBe(200);
      const raw = signedUp.headers['set-cookie'];
      const cookie = ((Array.isArray(raw) ? raw[0] : raw) ?? '').split(';')[0] ?? '';
      const userId = signedUp.json().user.id as string;
      const headers = { cookie, origin };
      const campaignId = crypto.randomUUID();
      const created = await app.inject({
        method: 'POST',
        url: '/campaigns',
        headers,
        payload: {
          id: campaignId,
          system: FIXTURE_SYSTEM_DEFINITION.summary.ref,
          gameMode: 'standard',
          options: {},
          moduleIds: [],
          name: 'Sync Audit',
          description: '',
        },
      });
      expect(created.statusCode).toBe(201);

      const secret = 'hidden-gm-note';
      const mutation = (expectedVersion: number, name: string, withAudit: boolean) => ({
        mutationId: crypto.randomUUID(),
        campaignId,
        featureId: 'campaigns',
        tableName: 'campaigns',
        recordId: campaignId,
        operation: 'update',
        expectedVersion,
        payload: { name, description: 'Edited offline.' },
        ...(withAudit
          ? {
              audit: {
                campaignId,
                action: 'campaigns.updated',
                targetType: 'campaigns',
                targetId: campaignId,
                after: { version: expectedVersion + 1, note: secret },
                at: '2026-10-24T12:00:00Z',
                private: false,
              },
            }
          : {}),
        causalSequence: 1,
        state: 'pending',
        attemptCount: 1,
        recordedAt: '2026-10-24T12:00:00Z',
      });
      const upload = async (item: ReturnType<typeof mutation>) => {
        const response = await app.inject({
          method: 'POST',
          url: '/sync/mutations',
          headers,
          payload: { campaignId, replicaId: crypto.randomUUID(), mutations: [item] },
        });
        expect(response.statusCode).toBe(200);
        return (response.json().outcomes as { status: string }[]).map((o) => o.status);
      };
      const rows = () => sql<{ action: string; origin: string; actor: string; role: string }[]>`
        select action, origin_mutation_id as origin, actor_user_id as actor, actor_role as role
        from audit_campaign_events where campaign_id = ${campaignId}
        order by campaign_sequence`;

      // Accepted with an envelope, then the identical batch again (lost acknowledgement).
      const first = mutation(1, 'Renamed once', true);
      expect(await upload(first)).toEqual(['accepted']);
      expect(await upload(first)).toEqual(['accepted']);
      expect([...(await rows())]).toEqual([
        { action: 'campaign.created', origin: expect.any(String), actor: userId, role: 'owner' },
        { action: 'campaigns.updated', origin: first.mutationId, actor: userId, role: 'owner' },
      ]);

      // Stale version: conflict, no accepted history.
      expect(await upload(mutation(1, 'Stale', true))).toEqual(['conflict']);
      expect((await rows()).length).toBe(2);

      // Older client without an envelope: exactly one service-level event.
      expect(await upload(mutation(2, 'Legacy', false))).toEqual(['accepted']);
      expect((await rows()).map((row) => row.action)).toEqual([
        'campaign.created',
        'campaigns.updated',
        'campaign.details_updated',
      ]);
      expect(lines.join('\n')).not.toContain(secret);
    } finally {
      await app.close();
    }
  });
});
