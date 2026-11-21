import { afterEach, describe, expect, test } from 'bun:test';
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
  CampaignService,
  CampaignSettingRegistry,
  type CampaignSettingReplica,
  InMemoryCampaignRepository,
  OfflineCampaignRepository,
  type OfflineInvitationQueue,
  type SystemDefinition,
} from '@rpg/campaigns';
import {
  type AuditEvent,
  type AuditRecorder,
  type DeferredConflict,
  err,
  ok,
  type ReplicaPurged,
} from '@rpg/contracts';
import { type CampaignMembershipWriter, reconcileMembershipCache } from '@rpg/identity';
import {
  AuthorityMutationService,
  InMemoryMutationReceiptStore,
  MutationApplierRegistry,
  type MutationAuditInput,
  type MutationAuditParticipant,
  type MutationBatch,
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
import { Type } from '@sinclair/typebox';
import {
  CampaignSettingSyncMutationApplier,
  CampaignSyncMutationApplier,
} from './campaign-applier.ts';

const USER = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';
const CAMPAIGN = '00000000-0000-4000-8000-000000000003';
const REPLICA = '00000000-0000-4000-8000-000000000004';

const SYSTEM: SystemDefinition = {
  summary: {
    ref: { systemId: 'fixture-system', version: '0.1.0' },
    name: 'Fixture System',
    shortDescription: 'Fixture.',
    complexity: 'medium',
    documentationStatus: 'external',
    rulesEntryPoint: 'https://example.invalid/rules',
    integration: {
      mechanicsSupported: true,
      characterSheetSupported: true,
      rulesTextIntegrated: false,
      compendiumIntegrated: false,
    },
  },
  gameModes: [{ id: 'standard', label: 'Standard' }],
  options: [
    { key: 'tone', label: 'Tone', type: 'select', default: 'bright', values: ['bright', 'grim'] },
  ],
  compatibleModules: [{ id: 'weather', version: '1.0.0', name: 'Weather' }],
};

const INPUT: CampaignCreateInput = {
  id: CAMPAIGN,
  system: SYSTEM.summary.ref,
  gameMode: 'standard',
  options: { tone: 'grim' },
  moduleIds: ['weather'],
  name: 'Offline Road',
  description: 'Created without network.',
};

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function settingRegistry(): CampaignSettingRegistry {
  const registry = new CampaignSettingRegistry();
  registry.register({
    namespace: 'feature.weather',
    schema: Type.Object({ enabled: Type.Boolean() }, { additionalProperties: false }),
    memberVisible: true,
    writableRoles: ['owner'],
  });
  return registry;
}
function authority(
  installed: readonly SystemDefinition[] = [SYSTEM],
  audit: {
    readonly serviceRecorder?: AuditRecorder;
    readonly participant?: MutationAuditParticipant;
  } = {},
) {
  const repository = new InMemoryCampaignRepository();
  let revoked = false;
  // Current membership is the only authority: owners exist once creation committed them.
  const owners = new Map<string, string>();
  const isMember = (userId: string, campaignId: string) =>
    !revoked && owners.get(campaignId) === userId;
  const ownerWriter: CampaignMembershipWriter = {
    createOwner: async (input, transaction) => {
      const handle = transaction.handle as {
        insertOwner(candidate: typeof input): ReturnType<CampaignMembershipWriter['createOwner']>;
      };
      const inserted = await handle.insertOwner(input);
      if (inserted.ok) owners.set(input.campaignId, input.userId);
      return inserted;
    },
  };
  const campaignService = (recorder: AuditRecorder) =>
    new CampaignService(
      repository,
      {
        list: async () => installed.map((system) => system.summary),
        resolveLatest: async () => installed[0],
        resolveExact: async (ref) =>
          installed.find(
            (system) =>
              system.summary.ref.systemId === ref.systemId &&
              system.summary.ref.version === ref.version,
          ),
      },
      {
        resolve: async (userId, campaignId) =>
          isMember(userId, campaignId)
            ? ok({ userId, campaignId, role: 'owner' as const })
            : err('membership_not_found'),
        listCampaignIds: async () => [CAMPAIGN],
      },
      ownerWriter,
      { decide: (actor) => actor.role === 'owner' },
      settingRegistry(),
      recorder,
      { auditDegraded: () => undefined },
    );
  const campaigns = campaignService(audit.serviceRecorder ?? { record: async () => undefined });
  const appliers = new MutationApplierRegistry();
  appliers.register(
    new CampaignSyncMutationApplier(campaigns, campaignService({ record: async () => undefined })),
  );
  appliers.register(
    new CampaignSettingSyncMutationApplier(
      campaigns,
      campaignService({ record: async () => undefined }),
    ),
  );
  // No pre-existing membership: the create insert passes only through creation scope.
  const service = new AuthorityMutationService(
    {
      resolve: async (userId, campaignId) =>
        isMember(userId, campaignId) ? { userId, campaignId, role: 'owner' as const } : undefined,
    },
    appliers,
    new InMemoryMutationReceiptStore(),
    audit.participant,
  );
  const batches: MutationBatch[] = [];
  const uploaderFor = (userId: string): MutationUploader => ({
    upload: async (batch) => {
      batches.push(structuredClone(batch));
      return service.apply(userId, batch);
    },
  });
  const uploader = uploaderFor(USER);
  return {
    campaigns,
    repository,
    service,
    uploader,
    uploaderFor,
    batches,
    revoke: () => {
      revoked = true;
    },
  };
}

function device(filename: string) {
  const store = new SqliteReplicaStore(filename);
  const status = new SyncStatusStore();
  const hub = new ConflictHub();
  const actor = { userId: USER, campaignId: CAMPAIGN, role: 'owner' as const };
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
  const queued = new Map<string, Parameters<OfflineInvitationQueue['queue']>[0]>();
  const offline = new OfflineCampaignRepository(
    campaigns,
    settings,
    { queue: async (input) => void queued.set(input.intentId, input) },
    settingRegistry(),
  );
  const purged: ReplicaPurged[] = [];
  const replicas = new ReplicaManager(store, status, [
    { replicaPurged: async (event) => void purged.push(event) },
  ]);
  // Feature 01's rule injected into feature 03's provider-neutral reconciler.
  const access = new ReplicaAccessReconciler(store, replicas, reconcileMembershipCache);
  return {
    store,
    status,
    campaigns,
    settings,
    offline,
    queued,
    purged,
    queue: new MutationQueue(store, status, hub),
    replicas,
    access,
    sync: new CampaignReplicaSync(offline, access),
  };
}

function replicaFile(): string {
  const directory = mkdtempSync(join(tmpdir(), 'rpg-campaign-offline-'));
  directories.push(directory);
  return join(directory, 'replica.sqlite');
}

describe('offline campaign creation through the sync queue', () => {
  test('survives restart and converges with identical IDs and pins exactly once', async () => {
    const filename = replicaFile();
    const server = authority();
    const first = device(filename);
    first.status.setConnected(false);
    const created = await first.offline.create(USER, INPUT, SYSTEM, ['player']);
    expect(created.ok).toBe(true);
    expect(await first.offline.getContext(CAMPAIGN)).toMatchObject({
      campaignId: CAMPAIGN,
      system: SYSTEM.summary.ref,
    });
    expect(await first.queue.drain(CAMPAIGN, REPLICA, server.uploader)).toEqual([]);
    expect(server.batches).toHaveLength(0);
    expect(first.queued.size).toBe(0);
    first.store.close();

    const restarted = device(filename);
    const local = await restarted.offline.getContext(CAMPAIGN);
    expect(restarted.store.pending(CAMPAIGN)).toHaveLength(1);
    expect(restarted.store.pending(CAMPAIGN)[0]).toMatchObject({
      operation: 'insert',
      recordId: CAMPAIGN,
      tableName: CAMPAIGN_REPLICA_TABLE,
    });
    expect(restarted.queued.size).toBe(0);

    expect(await restarted.queue.drain(CAMPAIGN, REPLICA, server.uploader)).toEqual([]);
    expect(restarted.status.snapshot().state).toBe('synchronized');
    const remote = await server.campaigns.resolve(USER, CAMPAIGN);
    expect(remote).toEqual(local);
    expect(remote?.modulePins).toEqual([{ moduleId: 'weather', version: '1.0.0' }]);

    await restarted.offline.authorityAccepted(CAMPAIGN);
    expect([...restarted.queued.values()]).toEqual([
      expect.objectContaining({ campaignId: CAMPAIGN, role: 'player' }),
    ]);

    // Lost acknowledgement: the same batch is replayed and must not create anything new.
    const [batch] = server.batches;
    if (batch === undefined) throw new Error('missing batch');
    const replay = await server.service.apply(USER, batch);
    expect(replay).toEqual([expect.objectContaining({ status: 'accepted', acceptedVersion: 1 })]);
    expect(await server.repository.list([CAMPAIGN])).toHaveLength(1);
    restarted.store.close();
  });

  test('uploads creation and later edits in causal order', async () => {
    const server = authority();
    const local = device(':memory:');
    await local.offline.create(USER, INPUT, SYSTEM);
    await local.offline.updateDetails(USER, CAMPAIGN, {
      name: 'Renamed offline',
      description: 'Edited.',
      expectedVersion: 1,
    });
    await local.queue.drain(CAMPAIGN, REPLICA, server.uploader);
    expect(server.batches[0]?.mutations.map((mutation) => mutation.operation)).toEqual([
      'insert',
      'update',
    ]);
    const remote = await server.campaigns.get(USER, CAMPAIGN);
    expect(remote.ok && remote.value).toMatchObject({ name: 'Renamed offline', version: 2 });
  });

  test('rejected creation commits nothing at authority and queues no invitation', async () => {
    const server = authority([]);
    const local = device(':memory:');
    await local.offline.create(USER, INPUT, SYSTEM, ['player']);
    await local.queue.drain(CAMPAIGN, REPLICA, server.uploader);
    expect(local.status.snapshot()).toMatchObject({ state: 'error', errorCode: 'upload_rejected' });
    expect(await server.repository.get(CAMPAIGN)).toBeUndefined();
    expect(local.queued.size).toBe(0);
    expect(local.store.pendingCount(CAMPAIGN)).toBe(1);
  });

  test('stale offline edit becomes a deferred conflict without replacing the local value', async () => {
    const server = authority();
    const local = device(':memory:');
    await local.offline.create(USER, INPUT, SYSTEM);
    await local.queue.drain(CAMPAIGN, REPLICA, server.uploader);
    await server.campaigns.updateDetails(USER, CAMPAIGN, {
      name: 'Server name',
      description: 'Server.',
      expectedVersion: 1,
    });
    const conflicts: DeferredConflict[] = [];
    local.campaigns.conflicts.subscribe((conflict) => conflicts.push(conflict));
    await local.offline.updateDetails(USER, CAMPAIGN, {
      name: 'Device name',
      description: 'Device.',
      expectedVersion: 1,
    });
    await local.queue.drain(CAMPAIGN, REPLICA, server.uploader);
    expect(conflicts).toEqual([
      expect.objectContaining({ id: CAMPAIGN, expectedVersion: 1, actualVersion: 2 }),
    ]);
    expect((await local.offline.get(CAMPAIGN))?.name).toBe('Device name');
    const remote = await server.campaigns.get(USER, CAMPAIGN);
    expect(remote.ok && remote.value.name).toBe('Server name');
  });

  test('deletion tombstone and membership revocation remove local context', async () => {
    const server = authority();
    const deleted = device(':memory:');
    await deleted.offline.create(USER, INPUT, SYSTEM);
    await deleted.queue.drain(CAMPAIGN, REPLICA, server.uploader);
    expect((await deleted.offline.delete(CAMPAIGN, 1)).ok).toBe(true);
    expect(await deleted.offline.getContext(CAMPAIGN)).toBeUndefined();
    await deleted.queue.drain(CAMPAIGN, REPLICA, server.uploader);
    expect(await server.campaigns.resolve(USER, CAMPAIGN)).toBeUndefined();
    expect((await server.repository.get(CAMPAIGN))?.deletedAt).toBeDefined();

    const revokedServer = authority();
    const revoked = device(':memory:');
    await revoked.offline.create(USER, INPUT, SYSTEM, ['player']);
    await revoked.queue.drain(CAMPAIGN, REPLICA, revokedServer.uploader);
    revokedServer.revoke();
    await revoked.replicas.revoke(CAMPAIGN);
    expect(await revoked.offline.getContext(CAMPAIGN)).toBeUndefined();
    expect(revoked.store.pendingCount(CAMPAIGN)).toBe(0);
    await revoked.offline.authorityAccepted(CAMPAIGN);
    expect(revoked.queued.size).toBe(0);
  });
});

describe('creation-scoped upload authorization', () => {
  test('creator inserts a campaign with no prior membership; later items resolve membership', async () => {
    const server = authority();
    const local = device(':memory:');
    await local.offline.create(USER, INPUT, SYSTEM, ['player']);
    await local.offline.updateDetails(USER, CAMPAIGN, {
      name: 'Renamed offline',
      description: 'Edited.',
      expectedVersion: 1,
    });
    const report = await local.queue.drainWithOutcomes(CAMPAIGN, REPLICA, server.uploader);
    expect(report.state).toBe('uploaded');
    expect(report.outcomes.map(({ operation, result }) => ({ operation, result }))).toEqual([
      { operation: 'insert', result: 'accepted' },
      { operation: 'update', result: 'accepted' },
    ]);
    expect(await local.sync.afterDrain(report)).toEqual({ errors: [] });
    expect([...local.queued.values()]).toEqual([
      expect.objectContaining({ campaignId: CAMPAIGN, role: 'player' }),
    ]);
    const remote = await server.campaigns.get(USER, CAMPAIGN);
    expect(remote.ok && remote.value).toMatchObject({ name: 'Renamed offline', version: 2 });
  });

  test('another authenticated user cannot upload a create naming a different creator', async () => {
    const server = authority();
    const local = device(':memory:');
    await local.offline.create(USER, INPUT, SYSTEM, ['player']);
    const report = await local.queue.drainWithOutcomes(
      CAMPAIGN,
      REPLICA,
      server.uploaderFor(OTHER),
    );
    expect(report.outcomes[0]).toMatchObject({
      result: 'rejected',
      outcome: { status: 'error', code: 'invalid_campaign_mutation' },
    });
    expect(await server.repository.get(CAMPAIGN)).toBeUndefined();
    expect(local.queued.size).toBe(0);
  });

  test('a non-member re-creating an existing campaign ID is denied without revealing it', async () => {
    const server = authority();
    const owner = device(':memory:');
    await owner.offline.create(USER, INPUT, SYSTEM);
    await owner.queue.drain(CAMPAIGN, REPLICA, server.uploader);
    const stranger = device(':memory:');
    await stranger.offline.create(OTHER, { ...INPUT, name: 'Squatter' }, SYSTEM);
    const report = await stranger.queue.drainWithOutcomes(
      CAMPAIGN,
      REPLICA,
      server.uploaderFor(OTHER),
    );
    expect(report.outcomes[0]?.outcome).toEqual({
      mutationId: expect.any(String),
      status: 'error',
      code: 'not_found_or_forbidden',
      retryable: false,
    });
    expect((await server.repository.get(CAMPAIGN))?.name).toBe('Offline Road');
  });

  test('revoked creator cannot re-create or edit, regardless of cached owner role', async () => {
    const server = authority();
    const local = device(':memory:');
    await local.offline.create(USER, INPUT, SYSTEM);
    await local.queue.drain(CAMPAIGN, REPLICA, server.uploader);
    server.revoke();
    const [created] = server.batches[0]?.mutations ?? [];
    if (created === undefined) throw new Error('missing create');
    const replayedAsNew = await server.service.apply(USER, {
      campaignId: CAMPAIGN,
      replicaId: REPLICA,
      mutations: [{ ...created, mutationId: crypto.randomUUID() }],
    });
    expect(replayedAsNew[0]).toMatchObject({ status: 'error', code: 'not_found_or_forbidden' });
    await local.offline.updateDetails(USER, CAMPAIGN, {
      name: 'After removal',
      description: 'Denied.',
      expectedVersion: 1,
    });
    const report = await local.queue.drainWithOutcomes(CAMPAIGN, REPLICA, server.uploader);
    expect(report.outcomes).toEqual([
      expect.objectContaining({
        operation: 'update',
        result: 'rejected',
        outcome: expect.objectContaining({ code: 'not_found_or_forbidden' }),
      }),
    ]);
    expect((await server.repository.get(CAMPAIGN))?.name).toBe('Offline Road');
  });

  test('items before the create, and non-create items without membership, fail closed', async () => {
    const server = authority();
    const local = device(':memory:');
    await local.offline.create(USER, INPUT, SYSTEM);
    const [create] = local.store.pending(CAMPAIGN);
    if (create === undefined) throw new Error('missing create');
    const outcomes = await server.service.apply(USER, {
      campaignId: CAMPAIGN,
      replicaId: REPLICA,
      mutations: [
        {
          ...create,
          mutationId: crypto.randomUUID(),
          operation: 'update',
          expectedVersion: 1,
          causalSequence: 1,
        },
        { ...create, causalSequence: 2 },
      ],
    });
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['error', 'accepted']);
    expect(outcomes[0]).toMatchObject({ code: 'not_found_or_forbidden' });
  });
});

describe('offline namespaced settings through the sync queue', () => {
  test('setting written after offline creation converges with the same version', async () => {
    const server = authority();
    const local = device(':memory:');
    await local.offline.create(USER, INPUT, SYSTEM);
    const written = await local.offline.writeSetting(
      USER,
      CAMPAIGN,
      'feature.weather',
      { enabled: true },
      null,
    );
    expect(written.ok).toBe(true);
    expect(await local.queue.drain(CAMPAIGN, REPLICA, server.uploader)).toEqual([]);
    expect(server.batches[0]?.mutations.map((mutation) => mutation.tableName)).toEqual([
      CAMPAIGN_REPLICA_TABLE,
      CAMPAIGN_SETTING_REPLICA_TABLE,
    ]);
    expect(await server.campaigns.getSetting(USER, CAMPAIGN, 'feature.weather')).toEqual({
      ok: true,
      value: { value: { enabled: true }, version: 1 },
    });
    expect(await server.campaigns.resolve(USER, CAMPAIGN)).toEqual(
      await local.offline.getContext(CAMPAIGN),
    );
    expect(local.status.snapshot().state).toBe('synchronized');
  });

  test('stale setting write becomes a deferred conflict with the authority value', async () => {
    const server = authority();
    const local = device(':memory:');
    await local.offline.create(USER, INPUT, SYSTEM);
    await local.offline.writeSetting(USER, CAMPAIGN, 'feature.weather', { enabled: true }, null);
    await local.queue.drain(CAMPAIGN, REPLICA, server.uploader);
    expect(
      (
        await server.campaigns.updateSetting(USER, CAMPAIGN, 'feature.weather', {
          value: { enabled: false },
          expectedVersion: 1,
        })
      ).ok,
    ).toBe(true);
    const conflicts: DeferredConflict[] = [];
    local.settings.conflicts.subscribe((conflict) => conflicts.push(conflict));
    await local.offline.writeSetting(USER, CAMPAIGN, 'feature.weather', { enabled: true }, 1);
    const found = await local.queue.drain(CAMPAIGN, REPLICA, server.uploader);
    expect(conflicts).toEqual([
      expect.objectContaining({
        table: CAMPAIGN_SETTING_REPLICA_TABLE,
        expectedVersion: 1,
        actualVersion: 2,
      }),
    ]);
    expect(found[0]).toMatchObject({ currentValue: { enabled: false } });
    expect((await local.offline.getContext(CAMPAIGN))?.settings['feature.weather']).toEqual({
      enabled: true,
    });
    expect(await server.campaigns.getSetting(USER, CAMPAIGN, 'feature.weather')).toEqual({
      ok: true,
      value: { value: { enabled: false }, version: 2 },
    });
  });
});

describe('membership revocation and tombstones on reconnect (feature 03 task 07)', () => {
  const ownerRow = {
    campaignId: CAMPAIGN,
    userId: USER,
    role: 'owner' as const,
    version: 1,
    updatedAt: '2026-10-24T10:00:00Z',
    removedAt: null,
  };

  test('revoked replica loses campaign data and pending work on reconnect', async () => {
    const server = authority();
    const local = device(':memory:');
    await local.offline.create(USER, INPUT, SYSTEM, ['player']);
    await local.queue.drain(CAMPAIGN, REPLICA, server.uploader);
    await local.access.applyMemberships(USER, [ownerRow], { complete: true });
    expect(local.access.actor(USER, CAMPAIGN)?.role).toBe('owner');

    // Offline edit is queued, then the authority removes the member.
    local.status.setConnected(false);
    await local.offline.updateDetails(USER, CAMPAIGN, {
      name: 'Never uploaded',
      description: 'Queued while offline.',
      expectedVersion: 1,
    });
    expect(local.store.pendingCount(CAMPAIGN)).toBe(1);
    server.revoke();

    // Reconnect: the current-user stream delivers the tombstone before any upload.
    local.status.setConnected(true);
    const report = await local.access.applyMemberships(
      USER,
      [{ ...ownerRow, version: 2, removedAt: '2026-10-24T11:00:00Z' }],
      { complete: true },
    );
    expect(report.removed).toEqual([CAMPAIGN]);
    expect(local.purged).toEqual([
      expect.objectContaining({ campaignId: CAMPAIGN, reason: 'access_revoked' }),
    ]);
    expect(await local.offline.getContext(CAMPAIGN)).toBeUndefined();
    expect(local.store.pendingCount()).toBe(0);
    const batches = server.batches.length;
    expect(await local.queue.drainWithOutcomes(CAMPAIGN, REPLICA, server.uploader)).toMatchObject({
      state: 'empty',
    });
    expect(server.batches).toHaveLength(batches);
    expect((await server.repository.get(CAMPAIGN))?.name).toBe('Offline Road');
    // A revoked replica refuses new local writes for the campaign.
    expect((await local.offline.create(USER, INPUT, SYSTEM)).ok).toBe(false);
    expect(local.access.actor(USER, CAMPAIGN)).toBeUndefined();
  });

  test('higher membership version replaces the cached role', async () => {
    const local = device(':memory:');
    await local.access.applyMemberships(USER, [ownerRow], { complete: true });
    await local.access.applyMemberships(USER, [{ ...ownerRow, role: 'player', version: 2 }], {
      complete: true,
    });
    expect(local.access.actor(USER, CAMPAIGN)?.role).toBe('player');
    await local.access.applyMemberships(USER, [{ ...ownerRow, version: 2 }], { complete: true });
    expect(local.access.actor(USER, CAMPAIGN)?.role).toBe('player');
  });

  test('accepted campaign deletion removes local context and replica', async () => {
    const server = authority();
    const local = device(':memory:');
    await local.offline.create(USER, INPUT, SYSTEM);
    await local.queue.drain(CAMPAIGN, REPLICA, server.uploader);
    await local.access.applyMemberships(USER, [ownerRow], { complete: true });
    expect((await local.offline.delete(CAMPAIGN, 1)).ok).toBe(true);
    // The local tombstone uploads first; only authority acceptance destroys the replica.
    expect(local.store.pendingCount(CAMPAIGN)).toBe(1);
    const report = await local.queue.drainWithOutcomes(CAMPAIGN, REPLICA, server.uploader);
    expect(await local.sync.afterDrain(report)).toEqual({ errors: [] });
    expect((await server.repository.get(CAMPAIGN))?.deletedAt).toBeDefined();
    expect(local.purged).toEqual([expect.objectContaining({ reason: 'campaign_deleted' })]);
    expect(local.store.list(CAMPAIGN_REPLICA_TABLE, CAMPAIGN, { includeDeleted: true })).toEqual(
      [],
    );
    expect(local.store.cachedMembership(CAMPAIGN)).toBeUndefined();
  });

  test('bootstrap denial keeps an unaccepted offline creation but drops a confirmed replica', async () => {
    const local = device(':memory:');
    await local.offline.create(USER, INPUT, SYSTEM);
    expect(await local.access.accessDenied(CAMPAIGN)).toBeUndefined();
    expect(local.store.pendingCount(CAMPAIGN)).toBe(1);
    await local.access.applyMemberships(USER, [ownerRow], { complete: false });
    expect((await local.access.accessDenied(CAMPAIGN))?.event.reason).toBe('access_revoked');
    expect(local.store.pendingCount(CAMPAIGN)).toBe(0);
    expect(await local.offline.getContext(CAMPAIGN)).toBeUndefined();
  });
});

describe('campaign replica composition (feature 02 task 06)', () => {
  const ownerRow = {
    campaignId: CAMPAIGN,
    userId: USER,
    role: 'owner' as const,
    version: 1,
    updatedAt: '2026-10-24T10:00:00Z',
    removedAt: null,
  };

  test('invitations queue only after authority acceptance, never offline, once per intent', async () => {
    const server = authority();
    const local = device(':memory:');
    local.status.setConnected(false);
    await local.offline.create(USER, INPUT, SYSTEM, ['player', 'assistant_gm']);
    const offline = await local.queue.drainWithOutcomes(CAMPAIGN, REPLICA, server.uploader);
    expect(offline.state).toBe('offline');
    await local.sync.afterDrain(offline);
    expect(local.queued.size).toBe(0);
    expect(local.store.hasAcceptedCreation(CAMPAIGN)).toBe(false);

    local.status.setConnected(true);
    const report = await local.queue.drainWithOutcomes(CAMPAIGN, REPLICA, server.uploader);
    expect(local.queued.size).toBe(0);
    await local.sync.afterDrain(report);
    expect([...local.queued.values()].map((item) => item.role).sort()).toEqual([
      'assistant_gm',
      'player',
    ]);
    // Same report observed again (retry after a partial dispatch): intents are idempotent.
    await local.sync.afterDrain(report);
    expect(local.queued.size).toBe(2);
  });

  test('rejected or denied creation queues no invitation and leaves no authority aggregate', async () => {
    const rejectedServer = authority([]);
    const local = device(':memory:');
    await local.offline.create(USER, INPUT, SYSTEM, ['player']);
    const report = await local.queue.drainWithOutcomes(CAMPAIGN, REPLICA, rejectedServer.uploader);
    expect(report.outcomes).toEqual([expect.objectContaining({ result: 'rejected' })]);
    await local.sync.afterDrain(report);
    expect(local.queued.size).toBe(0);
    expect(local.store.hasAcceptedCreation(CAMPAIGN)).toBe(false);
    expect(await rejectedServer.repository.get(CAMPAIGN)).toBeUndefined();
    expect(await local.offline.getContext(CAMPAIGN)).toBeDefined();

    // A creation that names an existing campaign ID is denied without a partial aggregate.
    const server = authority();
    const owner = device(':memory:');
    await owner.offline.create(USER, INPUT, SYSTEM);
    await owner.queue.drain(CAMPAIGN, REPLICA, server.uploader);
    const stranger = device(':memory:');
    await stranger.offline.create(OTHER, { ...INPUT, name: 'Squatter' }, SYSTEM, ['gm']);
    const denied = await stranger.queue.drainWithOutcomes(
      CAMPAIGN,
      REPLICA,
      server.uploaderFor(OTHER),
    );
    await stranger.sync.afterDrain(denied);
    expect(stranger.queued.size).toBe(0);
    expect(await server.repository.list([CAMPAIGN])).toHaveLength(1);
  });

  test('restart after acceptance but before dispatch still releases invitations exactly once', async () => {
    const filename = replicaFile();
    const server = authority();
    const first = device(filename);
    await first.offline.create(USER, INPUT, SYSTEM, ['player']);
    // Authority accepted and the outcome is persisted, then the process stops before afterDrain.
    expect((await first.queue.drainWithOutcomes(CAMPAIGN, REPLICA, server.uploader)).state).toBe(
      'uploaded',
    );
    first.store.close();

    const restarted = device(filename);
    expect(restarted.queued.size).toBe(0);
    const accepted = (id: string) => restarted.store.hasAcceptedCreation(id);
    await restarted.sync.resumeAccepted(CAMPAIGN, accepted);
    await restarted.sync.resumeAccepted(CAMPAIGN, accepted);
    expect(restarted.queued.size).toBe(1);
    restarted.store.close();

    // An unaccepted (rejected) creation is never resumed.
    const rejectedFile = replicaFile();
    const rejectedServer = authority([]);
    const rejected = device(rejectedFile);
    await rejected.offline.create(USER, INPUT, SYSTEM, ['player']);
    await rejected.queue.drain(CAMPAIGN, REPLICA, rejectedServer.uploader);
    rejected.store.close();
    const reopened = device(rejectedFile);
    await reopened.sync.resumeAccepted(CAMPAIGN, (id) => reopened.store.hasAcceptedCreation(id));
    expect(reopened.queued.size).toBe(0);
    reopened.store.close();
  });

  test('server campaign tombstone destroys local context; live rows and local-only deletes do not', async () => {
    const server = authority();
    const local = device(':memory:');
    await local.offline.create(USER, INPUT, SYSTEM);
    await local.queue.drain(CAMPAIGN, REPLICA, server.uploader);
    await local.access.applyMemberships(USER, [ownerRow], { complete: true });
    await local.sync.serverCampaigns([{ id: CAMPAIGN, deletedAt: null }, { id: CAMPAIGN }]);
    expect(await local.offline.getContext(CAMPAIGN)).toBeDefined();

    // Unconfirmed local delete stays queued: its mutation must still upload.
    local.status.setConnected(false);
    await local.offline.delete(CAMPAIGN, 1);
    await local.sync.afterDrain(
      await local.queue.drainWithOutcomes(CAMPAIGN, REPLICA, server.uploader),
    );
    expect(local.store.pendingCount(CAMPAIGN)).toBe(1);
    expect(local.purged).toEqual([]);
    local.status.setConnected(true);

    // Deleted elsewhere: the replica delivers the tombstone row.
    const result = await local.sync.serverCampaigns([
      { id: CAMPAIGN, deletedAt: '2026-10-24T12:00:00Z' },
    ]);
    expect(result.errors).toEqual([]);
    expect(local.purged).toEqual([
      expect.objectContaining({ campaignId: CAMPAIGN, reason: 'campaign_deleted' }),
    ]);
    expect(await local.offline.getContext(CAMPAIGN)).toBeUndefined();
    expect(local.store.pendingCount()).toBe(0);
    expect(local.store.cachedMembership(CAMPAIGN)).toBeUndefined();
  });

  test('bootstrap denial keeps an unaccepted creation and drops an accepted replica', async () => {
    const server = authority();
    const local = device(':memory:');
    await local.offline.create(USER, INPUT, SYSTEM, ['player']);
    await local.sync.bootstrapDenied(CAMPAIGN);
    expect(await local.offline.getContext(CAMPAIGN)).toBeDefined();
    expect(local.store.pendingCount(CAMPAIGN)).toBe(1);

    await local.sync.afterDrain(
      await local.queue.drainWithOutcomes(CAMPAIGN, REPLICA, server.uploader),
    );
    server.revoke();
    await local.sync.bootstrapDenied(CAMPAIGN);
    expect(await local.offline.getContext(CAMPAIGN)).toBeUndefined();
    expect(local.purged).toEqual([expect.objectContaining({ reason: 'access_revoked' })]);
  });

  test('conflict outcomes never reach acceptance handlers', async () => {
    const server = authority();
    const local = device(':memory:');
    await local.offline.create(USER, INPUT, SYSTEM, ['player']);
    await local.sync.afterDrain(
      await local.queue.drainWithOutcomes(CAMPAIGN, REPLICA, server.uploader),
    );
    expect(local.queued.size).toBe(1);
    await server.campaigns.updateDetails(USER, CAMPAIGN, {
      name: 'Server',
      description: '',
      expectedVersion: 1,
    });
    await local.offline.updateDetails(USER, CAMPAIGN, {
      name: 'Device',
      description: '',
      expectedVersion: 1,
    });
    const report = await local.queue.drainWithOutcomes(CAMPAIGN, REPLICA, server.uploader);
    expect(report.outcomes).toEqual([
      expect.objectContaining({
        result: 'conflict',
        outcome: expect.objectContaining({ expectedVersion: 1, actualVersion: 2 }),
      }),
    ]);
    await local.sync.afterDrain(report);
    expect(local.purged).toEqual([]);
    expect(await local.offline.getContext(CAMPAIGN)).toBeDefined();
  });

  test('conflict outcomes always carry a real base version (>= 1)', async () => {
    const server = authority();
    const local = device(':memory:');
    await local.offline.create(USER, INPUT, SYSTEM);
    await local.offline.writeSetting(USER, CAMPAIGN, 'feature.weather', { enabled: true }, null);
    await local.queue.drain(CAMPAIGN, REPLICA, server.uploader);
    const [create, setting] = server.batches[0]?.mutations ?? [];
    if (create === undefined || setting === undefined) throw new Error('missing mutations');
    const replay = (mutation: typeof create, patch: object) =>
      server.service.apply(USER, {
        campaignId: CAMPAIGN,
        replicaId: REPLICA,
        mutations: [{ ...mutation, mutationId: crypto.randomUUID(), causalSequence: 1, ...patch }],
      });
    // Update/tombstone without a base version is malformed, not a version conflict.
    expect((await replay(create, { operation: 'update' }))[0]).toMatchObject({
      status: 'error',
      code: 'invalid_campaign_mutation',
      retryable: false,
    });
    expect((await replay(create, { operation: 'tombstone' }))[0]).toMatchObject({
      status: 'error',
      code: 'invalid_campaign_mutation',
    });
    // A first write colliding with an existing setting has no base version to report.
    expect((await replay(setting, { expectedVersion: null }))[0]).toMatchObject({
      status: 'error',
      code: 'setting_already_exists',
      retryable: false,
    });
    const stale = await replay(create, { operation: 'update', expectedVersion: 7 });
    expect(stale[0]).toMatchObject({ status: 'conflict', expectedVersion: 7, actualVersion: 2 });
  });
});

describe('audit envelope through the sync queue (feature 06 task 02)', () => {
  /** Accepted-only and idempotent by mutation ID, like the durable recorder. */
  function audit() {
    const events = new Map<string, MutationAuditInput['audit']>();
    const serviceEvents: Omit<AuditEvent, 'id'>[] = [];
    const serviceRecorder: AuditRecorder = {
      record: async (event) => void serviceEvents.push(event),
    };
    const participant: MutationAuditParticipant = {
      recordMutationOutcome: async (input) => {
        if (input.outcome.status === 'accepted' && !events.has(input.mutationId)) {
          events.set(input.mutationId, input.audit);
        }
      },
    };
    return { events, serviceEvents, serviceRecorder, participant };
  }

  test('envelope audits each accepted mutation once under its mutation ID; service stays silent', async () => {
    const log = audit();
    const server = authority([SYSTEM], log);
    const local = device(':memory:');
    await local.offline.create(USER, INPUT, SYSTEM);
    await local.offline.updateDetails(USER, CAMPAIGN, {
      name: 'Renamed',
      description: 'Edited.',
      expectedVersion: 1,
    });
    await local.offline.writeSetting(USER, CAMPAIGN, 'feature.weather', { enabled: true }, null);
    const ids = local.store.pending(CAMPAIGN).map((item) => item.mutationId);
    expect(await local.queue.drain(CAMPAIGN, REPLICA, server.uploader)).toEqual([]);

    expect([...log.events.keys()]).toEqual(ids);
    expect([...log.events.values()].map((event) => [event.action, event.targetType])).toEqual([
      ['campaigns.created', CAMPAIGN_REPLICA_TABLE],
      ['campaigns.updated', CAMPAIGN_REPLICA_TABLE],
      ['campaigns.created', CAMPAIGN_SETTING_REPLICA_TABLE],
    ]);
    for (const event of log.events.values()) {
      expect(event.actor).toEqual({ userId: USER, campaignId: CAMPAIGN, role: 'owner' });
    }
    expect(log.serviceEvents).toEqual([]);

    // Lost acknowledgement: the same batch replays; nothing is applied or recorded twice.
    const [batch] = server.batches;
    if (batch === undefined) throw new Error('missing batch');
    await server.service.apply(USER, batch);
    expect([...log.events.keys()]).toEqual(ids);
    expect(log.serviceEvents).toEqual([]);
  });

  test('a mutation without an envelope falls back to exactly one service-level event', async () => {
    const log = audit();
    const server = authority([SYSTEM], log);
    const local = device(':memory:');
    await local.offline.create(USER, INPUT, SYSTEM);
    const legacy: MutationBatch = {
      campaignId: CAMPAIGN,
      replicaId: REPLICA,
      mutations: local.store.pending(CAMPAIGN).map(({ audit: _envelope, ...rest }) => rest),
    };
    await server.service.apply(USER, legacy);
    await server.service.apply(USER, legacy);
    expect(log.events.size).toBe(0);
    expect(log.serviceEvents.map((event) => event.action)).toEqual(['campaign.created']);
  });

  test('a conflicting or rejected mutation leaves no accepted history', async () => {
    const log = audit();
    const server = authority([SYSTEM], log);
    const local = device(':memory:');
    await local.offline.create(USER, INPUT, SYSTEM);
    await local.queue.drain(CAMPAIGN, REPLICA, server.uploader);
    await server.campaigns.updateDetails(USER, CAMPAIGN, {
      name: 'Server name',
      description: 'Server.',
      expectedVersion: 1,
    });
    const afterCreate = log.events.size;
    await local.offline.updateDetails(USER, CAMPAIGN, {
      name: 'Stale',
      description: 'Stale.',
      expectedVersion: 1,
    });
    await local.queue.drain(CAMPAIGN, REPLICA, server.uploader);
    expect(local.store.conflicts(CAMPAIGN)).toHaveLength(1);
    expect(log.events.size).toBe(afterCreate);

    const rejecting = authority([], log);
    const other = device(':memory:');
    await other.offline.create(USER, INPUT, SYSTEM);
    const before = log.events.size;
    await other.queue.drain(CAMPAIGN, REPLICA, rejecting.uploader);
    expect(other.status.snapshot().errorCode).toBe('upload_rejected');
    expect(log.events.size).toBe(before);
  });

  test('a forged envelope cannot name another campaign, target, or actor', async () => {
    const log = audit();
    const server = authority([SYSTEM], log);
    const local = device(':memory:');
    await local.offline.create(USER, INPUT, SYSTEM);
    const forged = crypto.randomUUID();
    const [create] = local.store.pending(CAMPAIGN);
    if (create?.audit === undefined) throw new Error('missing envelope');
    await server.service.apply(USER, {
      campaignId: CAMPAIGN,
      replicaId: REPLICA,
      mutations: [
        {
          ...create,
          audit: {
            ...create.audit,
            campaignId: forged,
            targetId: forged,
            targetType: 'forged',
            actor: { userId: forged, campaignId: forged, role: 'owner' },
          },
        },
      ],
    });
    expect(log.events.get(create.mutationId)).toMatchObject({
      campaignId: CAMPAIGN,
      targetId: CAMPAIGN,
      targetType: CAMPAIGN_REPLICA_TABLE,
      actor: { userId: USER, campaignId: CAMPAIGN, role: 'owner' },
    });
  });
});
