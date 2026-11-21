import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CAMPAIGN_REPLICA_TABLE,
  CAMPAIGN_SETTING_REPLICA_TABLE,
  CAMPAIGN_SYNC_FEATURE_ID,
  type CampaignCreateInput,
  type CampaignReplica,
  CampaignReplicaSync,
  CampaignSettingRegistry,
  type CampaignSettingReplica,
  OfflineCampaignRepository,
  type OfflineInvitationQueue,
  type SystemDefinition,
} from '@rpg/campaigns';
import type { DeferredConflict, ReplicaPurged } from '@rpg/contracts';
import { FIXTURE_SYSTEM_DEFINITION } from '@rpg/fixtures';
import { reconcileMembershipCache } from '@rpg/identity';
import {
  type CachedMembership,
  type MutationBatch,
  type MutationOutcome,
  type MutationUploader,
  SyncStatusStore,
} from '@rpg/sync';
import {
  ConflictHub,
  MutationQueue,
  ReplicaAccessReconciler,
  ReplicaManager,
  SqliteReplicaStore,
  SqliteSyncedRepository,
} from '@rpg/sync/bun';
import postgres from 'postgres';
import { buildRuntimeApp } from './runtime.ts';

/**
 * Feature 02 task 06 against the real authority: a device replica (SQLite, queue, reconciler)
 * uploads through `POST /sync/mutations` into the runtime composition root, so creation-scoped
 * authorization, membership resolution, the campaign service, and PostgreSQL are all real.
 * Membership and campaign rows are read back with SQL, as the sync provider would deliver them.
 * Skipped when no database is reachable.
 */

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const origin = 'https://table.invalid';
const sql = databaseUrl === undefined ? undefined : postgres(databaseUrl, { max: 2 });
const db = sql as NonNullable<typeof sql>;
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

const SYSTEM: SystemDefinition = {
  ...FIXTURE_SYSTEM_DEFINITION,
  options: [
    { key: 'tone', label: 'Tone', type: 'select', default: 'bright', values: ['bright', 'grim'] },
  ],
  compatibleModules: [{ id: 'weather', version: '1.0.0', name: 'Weather' }],
};

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function replicaFile(): string {
  const directory = mkdtempSync(join(tmpdir(), 'rpg-offline-campaign-'));
  directories.push(directory);
  return join(directory, 'replica.sqlite');
}

type Session = { readonly cookie: string; readonly userId: string };

function harness() {
  if (databaseUrl === undefined) throw new Error('database unavailable');
  const app = buildRuntimeApp({
    databaseUrl,
    allowedOrigin: origin,
    production: false,
    powerSyncEndpoint: 'http://localhost:8080',
    powerSyncJwtSecret: 'ZGV2ZWxvcG1lbnQtb25seS1wb3dlcnN5bmMta2V5LTMyIQ',
    logger: false,
    systems: [SYSTEM],
    integrations: { audit: { record: async () => undefined } },
  });
  const suffix = crypto.randomUUID().slice(0, 8);
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
  const send = (
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
  /** Real HTTP upload; the response body is the authority's per-item outcomes. */
  const uploadAs = (who: Session) => {
    const batches: MutationBatch[] = [];
    const uploader: MutationUploader = {
      upload: async (batch) => {
        batches.push(structuredClone(batch));
        const response = await send(who, 'POST', '/sync/mutations', batch);
        expect(response.statusCode).toBe(200);
        return response.json<{ outcomes: MutationOutcome[] }>().outcomes;
      },
    };
    return { uploader, batches };
  };
  /** The current user's membership rows exactly as the `current_user_memberships` stream shapes them. */
  const membershipRows = async (who: Session): Promise<CachedMembership[]> => {
    const rows = await db`
      select campaign_id, user_id, role, version::int as version, updated_at, removed_at
      from identity_campaign_memberships where user_id = ${who.userId}`;
    return (rows ?? []).map((row) => ({
      campaignId: row.campaign_id,
      userId: row.user_id,
      role: row.role,
      version: row.version,
      updatedAt: new Date(row.updated_at).toISOString(),
      removedAt: row.removed_at === null ? null : new Date(row.removed_at).toISOString(),
    }));
  };
  const campaignRow = async (id: string) => {
    const [row] =
      await db`select id, version::int as version, name, deleted_at from campaigns where id = ${id}`;
    return row;
  };
  const count = async (id: string) => {
    const [row] = await db`select
      (select count(*) from campaigns where id = ${id})::int as campaigns,
      (select count(*) from campaign_system_pins where campaign_id = ${id})::int as system_pins,
      (select count(*) from campaign_module_pins where campaign_id = ${id})::int as module_pins,
      (select count(*) from identity_campaign_memberships where campaign_id = ${id})::int as members`;
    return row as { campaigns: number; system_pins: number; module_pins: number; members: number };
  };
  return { app, signUp, send, uploadAs, membershipRows, campaignRow, count };
}

function device(filename: string, userId: string, campaignId: string) {
  const store = new SqliteReplicaStore(filename);
  const status = new SyncStatusStore();
  const hub = new ConflictHub();
  const actor = { userId, campaignId, role: 'owner' as const };
  const campaigns = new SqliteSyncedRepository<CampaignReplica>(
    store,
    CAMPAIGN_REPLICA_TABLE,
    CAMPAIGN_SYNC_FEATURE_ID,
    actor,
    status,
    hub,
  );
  const settings = new SqliteSyncedRepository<CampaignSettingReplica>(
    store,
    CAMPAIGN_SETTING_REPLICA_TABLE,
    CAMPAIGN_SYNC_FEATURE_ID,
    actor,
    status,
    hub,
  );
  const queued: Parameters<OfflineInvitationQueue['queue']>[0][] = [];
  const invitations: OfflineInvitationQueue = {
    queue: async (input) => {
      if (!queued.some((item) => item.intentId === input.intentId)) queued.push(input);
    },
  };
  const offline = new OfflineCampaignRepository(
    campaigns,
    settings,
    invitations,
    new CampaignSettingRegistry(),
  );
  const purged: ReplicaPurged[] = [];
  const replicas = new ReplicaManager(store, status, [
    { replicaPurged: async (event) => void purged.push(event) },
  ]);
  const access = new ReplicaAccessReconciler(store, replicas, reconcileMembershipCache);
  return {
    store,
    status,
    offline,
    queued,
    purged,
    campaigns,
    access,
    queue: new MutationQueue(store, status, hub),
    sync: new CampaignReplicaSync(offline, access),
  };
}

function input(id: string, overrides: Partial<CampaignCreateInput> = {}): CampaignCreateInput {
  return {
    id,
    system: SYSTEM.summary.ref,
    gameMode: 'standard',
    options: { tone: 'grim' },
    moduleIds: ['weather'],
    name: 'Offline Road',
    description: 'Created without network.',
    ...overrides,
  };
}

const replica = () => crypto.randomUUID();

describe.skipIf(!available)('offline campaign creation against the real authority', () => {
  test('creation is readable at once, converges with identical IDs and pins, and survives restart and replay', async () => {
    const h = harness();
    try {
      const owner = await h.signUp('off_owner');
      const id = crypto.randomUUID();
      const replicaId = replica();
      const filename = replicaFile();
      const first = device(filename, owner.userId, id);
      first.status.setConnected(false);
      expect(
        (await first.offline.create(owner.userId, input(id), SYSTEM, ['player', 'assistant_gm']))
          .ok,
      ).toBe(true);
      // Readable immediately; the authority knows nothing and no invitation can exist yet.
      expect(await first.offline.getContext(id)).toMatchObject({
        campaignId: id,
        system: SYSTEM.summary.ref,
        modulePins: [{ moduleId: 'weather', version: '1.0.0' }],
      });
      expect((await h.send(owner, 'GET', `/campaigns/${id}`)).statusCode).toBe(404);
      expect(
        (await h.send(owner, 'POST', `/campaigns/${id}/invitations`, { targetRole: 'player' }))
          .statusCode,
      ).toBe(404);
      const { uploader, batches } = h.uploadAs(owner);
      const offlineReport = await first.queue.drainWithOutcomes(id, replicaId, uploader);
      expect(offlineReport.state).toBe('offline');
      await first.sync.afterDrain(offlineReport);
      expect(first.queued).toEqual([]);
      expect(batches).toEqual([]);
      expect(await h.count(id)).toMatchObject({ campaigns: 0, members: 0 });
      first.store.close();

      // Restart: the aggregate and its queued creation are still there; reconnect uploads once.
      const restarted = device(filename, owner.userId, id);
      expect(await restarted.offline.getContext(id)).toBeDefined();
      expect(restarted.store.pending(id)).toHaveLength(1);
      const report = await restarted.queue.drainWithOutcomes(id, replicaId, uploader);
      expect(report.outcomes).toEqual([
        expect.objectContaining({ operation: 'insert', result: 'accepted' }),
      ]);
      expect(restarted.queued).toEqual([]);
      await restarted.sync.afterDrain(report);
      expect(restarted.queued.map((item) => item.role).sort()).toEqual(['assistant_gm', 'player']);

      // Same IDs and pins at the authority, with the owner membership committed atomically.
      expect(await h.count(id)).toEqual({
        campaigns: 1,
        system_pins: 1,
        module_pins: 1,
        members: 1,
      });
      const [pin] =
        await db`select system_id, system_version from campaign_system_pins where campaign_id = ${id}`;
      expect(pin).toEqual({ system_id: 'fixture-system', system_version: '0.1.0' });
      const [modulePin] =
        await db`select module_id, module_version from campaign_module_pins where campaign_id = ${id}`;
      expect(modulePin).toEqual({ module_id: 'weather', module_version: '1.0.0' });
      const view = await h.send(owner, 'GET', `/campaigns/${id}`);
      expect(view.statusCode).toBe(200);
      expect(view.json()).toMatchObject({ id, name: 'Offline Road', version: 1 });

      // Invitations are real only now: the authority accepts the creation first.
      for (const intent of restarted.queued) {
        const invited = await h.send(owner, 'POST', `/campaigns/${id}/invitations`, {
          targetRole: intent.role,
        });
        expect(invited.statusCode).toBe(201);
      }

      // Lost acknowledgement: replaying the identical batch creates nothing new.
      const [batch] = batches;
      if (batch === undefined) throw new Error('missing batch');
      const replay = await h.send(owner, 'POST', '/sync/mutations', batch);
      expect(replay.json().outcomes).toEqual([
        expect.objectContaining({ status: 'accepted', acceptedVersion: 1 }),
      ]);
      expect(await h.count(id)).toEqual({
        campaigns: 1,
        system_pins: 1,
        module_pins: 1,
        members: 1,
      });

      // The membership stream confirms access, so the offline role resolves from the cache.
      await restarted.access.applyMemberships(owner.userId, await h.membershipRows(owner), {
        complete: true,
      });
      expect(restarted.access.actor(owner.userId, id)?.role).toBe('owner');
      restarted.store.close();
    } finally {
      await h.app.close();
    }
  });

  test('rejected creation leaves no partial aggregate at the authority and queues nothing', async () => {
    const h = harness();
    try {
      const owner = await h.signUp('rej_owner');
      const id = crypto.randomUUID();
      // The device holds a definition the authority does not have installed.
      const unknown: SystemDefinition = {
        ...SYSTEM,
        summary: { ...SYSTEM.summary, ref: { ...SYSTEM.summary.ref, version: '9.9.9' } },
      };
      const local = device(':memory:', owner.userId, id);
      expect(
        (
          await local.offline.create(
            owner.userId,
            input(id, { system: unknown.summary.ref }),
            unknown,
            ['player'],
          )
        ).ok,
      ).toBe(true);
      const { uploader } = h.uploadAs(owner);
      const report = await local.queue.drainWithOutcomes(id, replica(), uploader);
      expect(report.outcomes).toEqual([
        expect.objectContaining({
          result: 'rejected',
          outcome: expect.objectContaining({ status: 'error', retryable: false }),
        }),
      ]);
      await local.sync.afterDrain(report);
      expect(local.queued).toEqual([]);
      expect(await h.count(id)).toEqual({
        campaigns: 0,
        system_pins: 0,
        module_pins: 0,
        members: 0,
      });
      expect(local.store.hasAcceptedCreation(id)).toBe(false);
      expect(await local.offline.getContext(id)).toBeDefined();
      // The rejected aggregate stays visible with its upload error until bootstrap denies it;
      // a rejected creation is not "pending", so the denial then destroys it (nothing survives).
      expect(local.status.snapshot()).toMatchObject({
        state: 'error',
        errorCode: 'upload_rejected',
      });
      expect((await h.send(owner, 'GET', `/sync/bootstrap/${id}`)).statusCode).toBe(404);
      await local.sync.bootstrapDenied(id);
      expect(await local.offline.getContext(id)).toBeUndefined();
      expect(local.purged).toEqual([expect.objectContaining({ reason: 'access_revoked' })]);

      // Another user cannot create under, or learn about, an existing campaign ID.
      const stranger = await h.signUp('rej_stranger');
      const taken = crypto.randomUUID();
      const mine = device(':memory:', owner.userId, taken);
      await mine.offline.create(owner.userId, input(taken), SYSTEM);
      await mine.queue.drain(taken, replica(), uploader);
      const squat = device(':memory:', stranger.userId, taken);
      await squat.offline.create(stranger.userId, input(taken, { name: 'Squatter' }), SYSTEM, [
        'gm',
      ]);
      const denied = await squat.queue.drainWithOutcomes(
        taken,
        replica(),
        h.uploadAs(stranger).uploader,
      );
      expect(denied.outcomes[0]).toMatchObject({
        result: 'rejected',
        outcome: { status: 'error', code: 'not_found_or_forbidden' },
      });
      await squat.sync.afterDrain(denied);
      expect(squat.queued).toEqual([]);
      expect((await h.campaignRow(taken))?.name).toBe('Offline Road');
      expect(await h.count(taken)).toMatchObject({ campaigns: 1, members: 1 });
    } finally {
      await h.app.close();
    }
  });

  test('stale offline edit becomes a deferred conflict; the authority value stands', async () => {
    const h = harness();
    try {
      const owner = await h.signUp('cf_owner');
      const id = crypto.randomUUID();
      const local = device(':memory:', owner.userId, id);
      await local.offline.create(owner.userId, input(id), SYSTEM);
      const { uploader } = h.uploadAs(owner);
      await local.queue.drain(id, replica(), uploader);

      const conflicts: DeferredConflict[] = [];
      local.campaigns.conflicts.subscribe((conflict) => conflicts.push(conflict));
      local.status.setConnected(false);
      await local.offline.updateDetails(owner.userId, id, {
        name: 'Device name',
        description: '',
        expectedVersion: 1,
      });
      const online = await h.send(owner, 'PATCH', `/campaigns/${id}`, {
        name: 'Server name',
        description: '',
        expectedVersion: 1,
      });
      expect(online.statusCode).toBe(200);
      local.status.setConnected(true);
      const report = await local.queue.drainWithOutcomes(id, replica(), uploader);
      expect(report.outcomes).toEqual([
        expect.objectContaining({
          result: 'conflict',
          outcome: expect.objectContaining({ expectedVersion: 1, actualVersion: 2 }),
        }),
      ]);
      await local.sync.afterDrain(report);
      expect(conflicts).toEqual([
        expect.objectContaining({ id, expectedVersion: 1, actualVersion: 2 }),
      ]);
      expect((await local.offline.get(id))?.name).toBe('Device name');
      expect((await h.campaignRow(id))?.name).toBe('Server name');
      expect(local.purged).toEqual([]);
    } finally {
      await h.app.close();
    }
  });

  test('membership revocation removes local context and the authority refuses the stale edit', async () => {
    const h = harness();
    try {
      const owner = await h.signUp('rv_owner');
      const successor = await h.signUp('rv_successor');
      const id = crypto.randomUUID();
      const local = device(':memory:', owner.userId, id);
      await local.offline.create(owner.userId, input(id), SYSTEM);
      const { uploader } = h.uploadAs(owner);
      await local.sync.afterDrain(await local.queue.drainWithOutcomes(id, replica(), uploader));
      await local.access.applyMemberships(owner.userId, await h.membershipRows(owner), {
        complete: true,
      });
      expect(local.access.actor(owner.userId, id)?.role).toBe('owner');

      // Offline edit queued while the authority hands the table to someone else.
      local.status.setConnected(false);
      await local.offline.updateDetails(owner.userId, id, {
        name: 'Never uploaded',
        description: '',
        expectedVersion: 1,
      });
      const stale = structuredClone(local.store.pending(id));
      expect(stale).toHaveLength(1);
      const invited = await h.send(owner, 'POST', `/campaigns/${id}/invitations`, {
        targetRole: 'gm',
      });
      expect(
        (await h.send(successor, 'POST', `/invitations/${invited.json().token}/accept`)).statusCode,
      ).toBe(200);
      expect(
        (
          await h.send(owner, 'POST', `/campaigns/${id}/ownership-transfer`, {
            targetUserId: successor.userId,
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (await h.send(successor, 'DELETE', `/campaigns/${id}/members/${owner.userId}`)).statusCode,
      ).toBe(204);

      // Reconnect: the membership tombstone arrives before any upload and destroys the replica.
      local.status.setConnected(true);
      const rows = await h.membershipRows(owner);
      expect(rows.find((row) => row.campaignId === id)?.removedAt).not.toBeNull();
      const report = await local.access.applyMemberships(owner.userId, rows, { complete: true });
      expect(report.removed).toEqual([id]);
      expect(local.purged).toEqual([
        expect.objectContaining({ campaignId: id, reason: 'access_revoked' }),
      ]);
      expect(await local.offline.getContext(id)).toBeUndefined();
      expect(local.store.pendingCount()).toBe(0);
      expect(local.access.actor(owner.userId, id)).toBeUndefined();
      expect(await local.queue.drainWithOutcomes(id, replica(), uploader)).toMatchObject({
        state: 'empty',
      });

      // Even if the edit were sent anyway, the real authority fails closed on current membership.
      const forced = await h.send(owner, 'POST', '/sync/mutations', {
        campaignId: id,
        replicaId: replica(),
        mutations: stale,
      });
      expect(forced.json().outcomes).toEqual([
        expect.objectContaining({ status: 'error', code: 'not_found_or_forbidden' }),
      ]);
      expect((await h.campaignRow(id))?.name).toBe('Offline Road');
      expect((await h.send(owner, 'GET', `/sync/bootstrap/${id}`)).statusCode).toBe(404);
    } finally {
      await h.app.close();
    }
  });

  test('campaign deletion removes local context whether made on the device or elsewhere', async () => {
    const h = harness();
    try {
      const owner = await h.signUp('dl_owner');
      const { uploader } = h.uploadAs(owner);

      // A) Offline deletion: the tombstone uploads first; only acceptance destroys the replica.
      const mine = crypto.randomUUID();
      const local = device(':memory:', owner.userId, mine);
      await local.offline.create(owner.userId, input(mine), SYSTEM);
      await local.sync.afterDrain(await local.queue.drainWithOutcomes(mine, replica(), uploader));
      await local.access.applyMemberships(owner.userId, await h.membershipRows(owner), {
        complete: true,
      });
      local.status.setConnected(false);
      expect((await local.offline.delete(mine, 1)).ok).toBe(true);
      expect(await local.offline.getContext(mine)).toBeUndefined();
      await local.sync.afterDrain(await local.queue.drainWithOutcomes(mine, replica(), uploader));
      expect(local.purged).toEqual([]);
      expect(local.store.pendingCount(mine)).toBe(1);
      expect((await h.campaignRow(mine))?.deleted_at).toBeNull();
      local.status.setConnected(true);
      const report = await local.queue.drainWithOutcomes(mine, replica(), uploader);
      expect(report.outcomes).toEqual([
        expect.objectContaining({ operation: 'tombstone', result: 'accepted' }),
      ]);
      await local.sync.afterDrain(report);
      expect((await h.campaignRow(mine))?.deleted_at).not.toBeNull();
      expect(local.purged).toEqual([
        expect.objectContaining({ campaignId: mine, reason: 'campaign_deleted' }),
      ]);
      expect(local.store.cachedMembership(mine)).toBeUndefined();
      expect(local.store.pendingCount()).toBe(0);

      // B) Deleted from another session: the replicated tombstone row removes the context.
      const theirs = crypto.randomUUID();
      const other = device(':memory:', owner.userId, theirs);
      await other.offline.create(owner.userId, input(theirs), SYSTEM);
      await other.sync.afterDrain(await other.queue.drainWithOutcomes(theirs, replica(), uploader));
      await other.access.applyMemberships(owner.userId, await h.membershipRows(owner), {
        complete: true,
      });
      const deleted = await h.send(owner, 'DELETE', `/campaigns/${theirs}`, { expectedVersion: 1 });
      expect(deleted.statusCode).toBe(204);
      const row = await h.campaignRow(theirs);
      expect(row?.deleted_at).not.toBeNull();
      await other.sync.serverCampaigns([
        { id: row?.id, deletedAt: new Date(row?.deleted_at).toISOString() },
      ]);
      expect(other.purged).toEqual([
        expect.objectContaining({ campaignId: theirs, reason: 'campaign_deleted' }),
      ]);
      expect(await other.offline.getContext(theirs)).toBeUndefined();
      expect(other.store.pendingCount()).toBe(0);
    } finally {
      await h.app.close();
    }
  });
});
