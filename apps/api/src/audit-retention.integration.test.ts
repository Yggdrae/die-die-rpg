import { afterAll, describe, expect, test } from 'bun:test';
import { type AuditRetentionPlan, PostgresAuditRetentionExecutor } from '@rpg/audit';
import { FIXTURE_SYSTEM_DEFINITION } from '@rpg/fixtures';
import postgres from 'postgres';
import { connectAuditRetention } from './modules/audit/retention.ts';
import { buildRuntimeApp } from './runtime.ts';

/**
 * Feature 06 retention follow-up through the real composition (Fastify, PostgreSQL, feature 03
 * watermarks, feature 04 decisions, feature 01 roles):
 *
 * - a replica acknowledges the newest audit event it holds (`POST /sync/replicas/:id/ack`); the
 *   authority resolves it to a sequence only when that user may read the event;
 * - long-lived active replicas hold 365-day rows back as `unacknowledged_replica` until they
 *   acknowledge; a player replica never holds the GM-private store back;
 * - the executor deletes nothing by default, and when enabled deletes only the unblocked rows
 *   past 365 days, never younger ones.
 */

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const origin = 'https://table.invalid';
const sql = databaseUrl === undefined ? undefined : postgres(databaseUrl, { max: 2 });
const available = await (async () => {
  if (sql === undefined) return false;
  try {
    await sql`select 1 from audit_campaign_events limit 1`;
    await sql`select 1 from sync_replica_watermarks limit 1`;
    return true;
  } catch {
    return false;
  }
})();
const campaigns: string[] = [];
afterAll(async () => {
  if (sql !== undefined && campaigns.length > 0) {
    await sql`delete from sync_replica_watermarks where campaign_id = any(${campaigns}::uuid[])`;
    await sql`delete from sync_replica_subscriptions where campaign_id = any(${campaigns}::uuid[])`;
  }
  await sql?.end({ timeout: 1 });
});

const DAY = 86_400_000;

function runtime() {
  if (databaseUrl === undefined) throw new Error('database unavailable');
  return buildRuntimeApp({
    databaseUrl,
    allowedOrigin: origin,
    production: false,
    powerSyncEndpoint: 'http://localhost:8080',
    powerSyncJwtSecret: 'ZGV2ZWxvcG1lbnQtb25seS1wb3dlcnN5bmMta2V5LTMyIQ',
    logger: false,
  });
}

type App = ReturnType<typeof runtime>;

async function signUp(app: App, name: string) {
  const username = `${name}_${crypto.randomUUID().slice(0, 8)}`;
  const response = await app.inject({
    method: 'POST',
    url: '/auth/accounts',
    payload: { username, password: 'correct horse battery staple' },
  });
  expect(response.statusCode).toBe(200);
  const raw = response.headers['set-cookie'];
  const header = Array.isArray(raw) ? raw[0] : raw;
  return { cookie: (header ?? '').split(';')[0] ?? '', userId: response.json().user.id as string };
}

type Session = Awaited<ReturnType<typeof signUp>>;

function call(app: App, who: Session, method: 'POST' | 'PATCH', url: string, payload: object) {
  return app.inject({ method, url, headers: { cookie: who.cookie, origin }, payload });
}

type Store = 'audit_campaign_events' | 'audit_private_events';

describe.skipIf(!available)('audit retention with replica acknowledgement (runtime)', () => {
  test('active replicas acknowledge, stop blocking, and only unblocked old rows are deleted', async () => {
    if (sql === undefined || databaseUrl === undefined) return;
    const app = runtime();
    const retention = connectAuditRetention(databaseUrl);
    try {
      const owner = await signUp(app, 'ret_owner');
      const player = await signUp(app, 'ret_player');
      const campaignId = crypto.randomUUID();
      campaigns.push(campaignId);
      const created = await call(app, owner, 'POST', '/campaigns', {
        id: campaignId,
        system: FIXTURE_SYSTEM_DEFINITION.summary.ref,
        gameMode: 'standard',
        options: {},
        moduleIds: [],
        name: 'Old Road',
        description: '',
      });
      expect(created.statusCode).toBe(201);
      const invited = await call(app, owner, 'POST', `/campaigns/${campaignId}/invitations`, {
        targetRole: 'player',
      });
      expect(
        (await call(app, player, 'POST', `/invitations/${invited.json().token}/accept`, {}))
          .statusCode,
      ).toBe(200);

      // History older than 365 days (fabricated: the app always stamps acceptance with now()).
      const old = new Date(Date.now() - 400 * DAY);
      const lastSequence = async (store: Store) => {
        const allocator =
          store === 'audit_campaign_events'
            ? 'audit_campaign_sequences'
            : 'audit_private_sequences';
        const [row] = await sql<{ last: string }[]>`
          select coalesce(max(last_sequence), 0) as last from ${sql(allocator)}
          where campaign_id = ${campaignId}`;
        return Number(row?.last ?? 0);
      };
      const fabricate = async (store: Store, at: Date, visibility = 'everyone') => {
        const allocator =
          store === 'audit_campaign_events'
            ? 'audit_campaign_sequences'
            : 'audit_private_sequences';
        const sequence = (await lastSequence(store)) + 1;
        await sql`insert into ${sql(allocator)} (campaign_id, last_sequence)
          values (${campaignId}, ${sequence})
          on conflict (campaign_id) do update set last_sequence = excluded.last_sequence`;
        const id = crypto.randomUUID();
        await sql`insert into ${sql(store)} (id, campaign_id, campaign_sequence, actor_user_id,
            actor_role, action, target_type, target_id, target_visibility, client_recorded_at,
            accepted_at, origin_mutation_id, renderer_version)
          values (${id}, ${campaignId}, ${sequence}, ${owner.userId}, 'owner',
            'campaign.details_updated', 'campaign', ${campaignId},
            ${sql.json({ visibility: { mode: visibility } })}, ${at}, ${at},
            ${crypto.randomUUID()}, 1)`;
        return id;
      };
      await fabricate('audit_campaign_events', old);
      await fabricate('audit_campaign_events', old);
      await fabricate('audit_private_events', old);
      await fabricate('audit_private_events', old);
      // Recent history every replica would hold.
      const renamed = await call(app, owner, 'PATCH', `/campaigns/${campaignId}`, {
        name: 'Ashen Road',
        description: '',
        expectedVersion: created.json().version,
      });
      expect(renamed.statusCode).toBe(200);
      const [rename] = await sql<{ id: string }[]>`
        select id from audit_campaign_events
        where campaign_id = ${campaignId} and action = 'campaign.details_updated'
          and accepted_at > now() - interval '1 day'`;
      const privateRecent = await fabricate('audit_private_events', new Date());
      const [membership] = await sql<{ id: string }[]>`
        select id from audit_campaign_events
        where campaign_id = ${campaignId} and target_type = 'campaign_membership' limit 1`;
      expect(rename?.id).toBeDefined();
      expect(membership?.id).toBeDefined();

      // Two long-lived replicas, subscribed before the old rows were accepted.
      const ownerReplica = crypto.randomUUID();
      const playerReplica = crypto.randomUUID();
      const since = new Date(Date.now() - 500 * DAY);
      for (const [userId, replicaId] of [
        [owner.userId, ownerReplica],
        [player.userId, playerReplica],
      ] as const) {
        await sql`insert into sync_replica_subscriptions
          (campaign_id, replica_id, user_id, subscribed_at)
          values (${campaignId}, ${replicaId}, ${userId}, ${since})`;
      }

      const scoped = {
        plan: async (now?: Date): Promise<AuditRetentionPlan> => {
          const plan = await retention.reporter.plan(now);
          return {
            ...plan,
            stores: plan.stores.map(({ store, groups }) => ({
              store,
              groups: groups.filter((group) => group.campaignId === campaignId),
            })),
          };
        },
      };
      const blockers = async () => {
        const plan = await scoped.plan();
        const of = (store: string) =>
          plan.stores.find((item) => item.store === store)?.groups[0]?.blockers;
        return { campaign: of('campaign'), private: of('private') };
      };
      const ack = (who: Session, replicaId: string, tableName: Store, throughEventId: string) =>
        call(app, who, 'POST', `/sync/replicas/${campaignId}/ack`, {
          replicaId,
          tableName,
          throughEventId,
        });
      const marks = async () =>
        (
          await sql<{ replica_id: string; table_name: string; sequence: string }[]>`
            select replica_id, table_name, acknowledged_sequence as sequence
            from sync_replica_watermarks where campaign_id = ${campaignId}
            order by replica_id, table_name`
        )
          .map((row) => `${row.replica_id === ownerReplica ? 'owner' : 'player'}:${row.table_name}`)
          .sort();

      expect(await blockers()).toEqual({
        campaign: ['unacknowledged_replica'],
        private: ['unacknowledged_replica'],
      });

      // A player naming a GM-private or GM-only event moves no watermark (same 204).
      const forgedPrivate = await ack(player, playerReplica, 'audit_private_events', privateRecent);
      expect(forgedPrivate.statusCode).toBe(204);
      const forgedHidden = await ack(
        player,
        playerReplica,
        'audit_campaign_events',
        membership?.id ?? '',
      );
      expect(forgedHidden.statusCode).toBe(204);
      expect(
        (await ack(player, playerReplica, 'audit_campaign_events', crypto.randomUUID())).statusCode,
      ).toBe(204);
      expect(await marks()).toEqual([]);
      // A device cannot claim a raw audit sequence.
      expect(
        (
          await call(app, player, 'POST', `/sync/replicas/${campaignId}/ack`, {
            replicaId: playerReplica,
            tableName: 'audit_campaign_events',
            sequence: 1_000_000,
          })
        ).statusCode,
      ).toBe(400);

      // The owner acknowledges both stores; the player still holds the campaign store back.
      expect(
        (await ack(owner, ownerReplica, 'audit_campaign_events', rename?.id ?? '')).statusCode,
      ).toBe(204);
      expect(
        (await ack(owner, ownerReplica, 'audit_private_events', privateRecent)).statusCode,
      ).toBe(204);
      expect(await blockers()).toEqual({ campaign: ['unacknowledged_replica'], private: [] });
      // The player's replica never receives the private store, so it never blocked it.
      expect(
        (await ack(player, playerReplica, 'audit_campaign_events', rename?.id ?? '')).statusCode,
      ).toBe(204);
      expect(await blockers()).toEqual({ campaign: [], private: [] });
      expect(await marks()).toEqual([
        'owner:audit_campaign_events',
        'owner:audit_private_events',
        'player:audit_campaign_events',
      ]);

      const counts = async () => {
        const [row] = await sql<{ campaign: string; private: string; old: string }[]>`
          select
            (select count(*) from audit_campaign_events where campaign_id = ${campaignId}) as campaign,
            (select count(*) from audit_private_events where campaign_id = ${campaignId}) as private,
            (select count(*) from audit_campaign_events where campaign_id = ${campaignId}
               and accepted_at < now() - interval '365 days')
            + (select count(*) from audit_private_events where campaign_id = ${campaignId}
               and accepted_at < now() - interval '365 days') as old`;
        return {
          campaign: Number(row?.campaign),
          private: Number(row?.private),
          old: Number(row?.old),
        };
      };
      const before = await counts();
      expect(before.old).toBe(4);

      const executor = new PostgresAuditRetentionExecutor(retention.auditDb, scoped);
      // Default: report only, nothing deleted although every blocker is clear.
      const dry = await executor.run();
      expect(dry).toMatchObject({ mode: 'report_only', deletionEnabled: false, deleted: 0 });
      expect(await counts()).toEqual(before);

      const run = await executor.run({ delete: true, batchSize: 1 });
      expect(run).toMatchObject({ mode: 'delete', deleted: 4, truncated: false });
      expect(await counts()).toEqual({
        campaign: before.campaign - 2,
        private: before.private - 2,
        old: 0,
      });
      // Recent rows (the rename, the private event, membership history) stay.
      const [kept] = await sql<{ n: string }[]>`
        select count(*) as n from audit_campaign_events
        where id = any(${[rename?.id ?? '', membership?.id ?? '']}::uuid[])`;
      expect(Number(kept?.n)).toBe(2);
    } finally {
      await retention.close();
      await app.close();
    }
  });
});
