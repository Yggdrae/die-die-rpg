import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeEntity, repositoryContractTests } from '@rpg/contracts/testing/repository-contract';
import { Value } from '@sinclair/typebox/value';
import {
  AuthorityMutationService,
  InMemoryMutationReceiptStore,
  MutationApplierRegistry,
} from './authority.ts';
import { RegisteredPowerSyncConnector, selectBrowserStorageBackend } from './browser.ts';
import {
  ConflictHub,
  ConflictResolutionService,
  MutationQueue,
  ReplicaManager,
  SqliteSyncedRepository,
} from './bun-repository.ts';
import { SqliteReplicaStore } from './bun-sqlite.ts';
import { InMemoryLongTextHoldRepository, LongTextDraft, LongTextHoldService } from './holds.ts';
import type { MutationBatch, MutationOutcome, PendingMutation } from './model.ts';
import { MutationBatchSchema } from './schemas.ts';
import {
  applySemanticOperations,
  InMemorySemanticAuthorityStore,
  SemanticMutationApplier,
} from './semantic.ts';
import { LOCAL_SCHEMA_VERSION } from './sql-schema.ts';
import { SyncStatusStore } from './status.ts';
import { isTombstoneSafeToPurge } from './watermarks.ts';

const CAMPAIGN = '3f2504e0-4f89-41d3-9a0c-0305e82c3300';
const USER = '3f2504e0-4f89-41d3-9a0c-0305e82c3390';
const SESSION = '3f2504e0-4f89-41d3-9a0c-0305e82c3391';
const REPLICA = '3f2504e0-4f89-41d3-9a0c-0305e82c3392';
const ACTOR = { userId: USER, campaignId: CAMPAIGN, role: 'gm' as const };
const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function repository(store = new SqliteReplicaStore()) {
  return new SqliteSyncedRepository(
    store,
    'entities',
    'entities',
    ACTOR,
    new SyncStatusStore(),
    new ConflictHub(),
  );
}

repositoryContractTests('SQLite replica adapter', () => repository());

describe('SQLite replica and mutation queue', () => {
  test('reopens local records and pending mutations after restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rpg-sync-'));
    tempDirectories.push(directory);
    const filename = join(directory, 'replica.sqlite');
    const first = new SqliteReplicaStore(filename);
    await repository(first).upsert(makeEntity(crypto.randomUUID(), 'Offline NPC'), null);
    expect(first.pendingCount(CAMPAIGN)).toBe(1);
    first.close();

    const reopened = new SqliteReplicaStore(filename);
    expect(reopened.list('entities', CAMPAIGN, {})).toHaveLength(1);
    expect(reopened.pendingCount(CAMPAIGN)).toBe(1);
    reopened.close();
  });

  test('failed migration rolls back without discarding pending mutations', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rpg-sync-migration-'));
    tempDirectories.push(directory);
    const filename = join(directory, 'replica.sqlite');
    const store = new SqliteReplicaStore(filename);
    await repository(store).upsert(makeEntity(crypto.randomUUID(), 'Pending'), null);
    const before = store.pending(CAMPAIGN);
    expect(() =>
      store.applyMigration(
        LOCAL_SCHEMA_VERSION + 1,
        'ALTER TABLE sync_campaign_state ADD COLUMN migration_probe TEXT',
        () => {
          throw new Error('injected migration failure');
        },
      ),
    ).toThrow('injected migration failure');
    expect(store.schemaVersion()).toBe(LOCAL_SCHEMA_VERSION);
    expect(store.pending(CAMPAIGN)).toEqual(before);
    store.close();
    const recovered = new SqliteReplicaStore(filename);
    expect(recovered.schemaVersion()).toBe(LOCAL_SCHEMA_VERSION);
    expect(recovered.pending(CAMPAIGN)).toEqual(before);
    recovered.close();
  });

  test('capacity rejects a new write without evicting confirmed pending work', async () => {
    const store = new SqliteReplicaStore(':memory:', { capacityBytes: 2_000 });
    const repo = repository(store);
    const first = await repo.upsert(makeEntity(crypto.randomUUID(), 'Kept'), null);
    expect(first.ok).toBe(true);
    const before = store.pending(CAMPAIGN);
    const blocked = await repo.upsert(
      { ...makeEntity(crypto.randomUUID(), 'Blocked'), metadata: { text: 'x'.repeat(4_000) } },
      null,
    );
    expect(blocked.ok).toBe(false);
    expect(store.pending(CAMPAIGN)).toEqual(before);
  });

  test('drains in causal order and persists a deferred conflict without reverting local state', async () => {
    const store = new SqliteReplicaStore();
    const status = new SyncStatusStore();
    const hub = new ConflictHub();
    const repo = new SqliteSyncedRepository(store, 'entities', 'entities', ACTOR, status, hub);
    const id = crypto.randomUUID();
    const created = await repo.upsert(makeEntity(id, 'Local'), null);
    if (!created.ok) throw new Error('fixture create failed');
    await repo.upsert({ ...created.value, name: 'Local v2' }, created.value.version);
    const seen: unknown[] = [];
    repo.conflicts.subscribe((conflict) => seen.push(conflict));
    const uploadedSequences: number[] = [];
    const queue = new MutationQueue(store, status, hub);
    await queue.drain(CAMPAIGN, REPLICA, {
      upload: async (batch) => {
        uploadedSequences.push(...batch.mutations.map((mutation) => mutation.causalSequence));
        return batch.mutations.map((mutation, index) =>
          index === 0
            ? {
                mutationId: mutation.mutationId,
                status: 'accepted' as const,
                acceptedVersion: 1,
                serverCursor: 'cursor-1',
              }
            : {
                mutationId: mutation.mutationId,
                status: 'conflict' as const,
                expectedVersion: 1,
                actualVersion: 2,
                currentValue: { name: 'Authority' },
              },
        );
      },
    });
    expect(uploadedSequences).toEqual([1, 2]);
    expect(seen).toHaveLength(1);
    expect(store.conflicts(CAMPAIGN)).toHaveLength(1);
    const local = await repo.get(id);
    expect(local.ok && local.value.name).toBe('Local v2');
  });

  test('resolves a deferred conflict with a new durable versioned mutation', async () => {
    const store = new SqliteReplicaStore();
    const status = new SyncStatusStore();
    const repo = new SqliteSyncedRepository(
      store,
      'entities',
      'entities',
      ACTOR,
      status,
      new ConflictHub(),
    );
    const id = crypto.randomUUID();
    const created = await repo.upsert(makeEntity(id, 'Submitted'), null);
    if (!created.ok) throw new Error('fixture create failed');
    const [mutation] = store.pending(CAMPAIGN);
    if (mutation === undefined) throw new Error('fixture mutation missing');
    store.applyOutcomes(
      [
        {
          mutationId: mutation.mutationId,
          status: 'conflict',
          expectedVersion: 0,
          actualVersion: 3,
          currentValue: { ...created.value, name: 'Authority', version: 3 },
        },
      ],
      '2026-08-31T10:01:00Z',
    );
    const [conflict] = store.conflicts(CAMPAIGN);
    if (conflict === undefined) throw new Error('fixture conflict missing');

    const resolution = new ConflictResolutionService(
      store,
      status,
      USER,
      () => new Date('2026-08-31T10:02:00Z'),
      () => 'resolution-mutation',
    ).resolve({ conflictId: conflict.conflictId, choice: 'resubmit' });

    expect(resolution).toEqual({
      ok: true,
      value: {
        conflictId: conflict.conflictId,
        choice: 'resubmit',
        mutationId: 'resolution-mutation',
        resolvedVersion: 4,
      },
    });
    expect(store.conflicts(CAMPAIGN)).toHaveLength(0);
    expect(store.pending(CAMPAIGN)).toMatchObject([
      {
        mutationId: 'resolution-mutation',
        operation: 'resolution',
        expectedVersion: 3,
        causalSequence: 2,
      },
    ]);
    const local = await repo.get(id);
    expect(local.ok && local.value).toMatchObject({ name: 'Submitted', version: 4 });
  });

  test('keeps queued mutations durable when the upload transport fails', async () => {
    const store = new SqliteReplicaStore();
    const status = new SyncStatusStore();
    await repository(store).upsert(makeEntity(crypto.randomUUID(), 'Offline'), null);
    const before = store.pending(CAMPAIGN);
    await new MutationQueue(store, status, new ConflictHub()).drain(CAMPAIGN, REPLICA, {
      upload: async () => {
        throw new Error('network unavailable');
      },
    });
    expect(store.pending(CAMPAIGN).map((mutation) => mutation.mutationId)).toEqual(
      before.map((mutation) => mutation.mutationId),
    );
    expect(status.snapshot()).toMatchObject({ state: 'error', pendingCount: 1 });
  });

  test('revocation and sign-out remove records, pending payloads, and conflicts', async () => {
    const store = new SqliteReplicaStore();
    const status = new SyncStatusStore();
    await repository(store).upsert(makeEntity(crypto.randomUUID(), 'Private'), null);
    const manager = new ReplicaManager(store, status);
    await manager.revoke(CAMPAIGN);
    expect(store.list('entities', CAMPAIGN, {})).toHaveLength(0);
    expect(store.pendingCount(CAMPAIGN)).toBe(0);
  });

  test('bootstrap revocation drops the local campaign before reconnect continues', async () => {
    const store = new SqliteReplicaStore();
    const status = new SyncStatusStore();
    await repository(store).upsert(makeEntity(crypto.randomUUID(), 'Private'), null);
    const manager = new ReplicaManager(store, status);
    let noAccess = 0;
    const connector = new RegisteredPowerSyncConnector(
      {
        campaigns: async () => [CAMPAIGN],
        replicaId: async () => REPLICA,
        accessDenied: async (campaignId) => manager.revoke(campaignId),
        noAccess: () => {
          noAccess += 1;
        },
      },
      { nextBatch: async () => undefined, applyOutcomes: async () => undefined },
      async () => new Response(null, { status: 404 }),
    );

    await expect(connector.fetchCredentials()).rejects.toThrow('sync_bootstrap_failed');
    expect(store.list('entities', CAMPAIGN, {})).toHaveLength(0);
    expect(store.pendingCount(CAMPAIGN)).toBe(0);
    expect(noAccess).toBe(1);
  });

  test('a credential comes from any campaign that still authorizes the user', async () => {
    const OTHER = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
    const denied: string[] = [];
    const requested: string[] = [];
    const connector = new RegisteredPowerSyncConnector(
      {
        campaigns: async () => [CAMPAIGN, OTHER],
        replicaId: async () => REPLICA,
        accessDenied: async (campaignId) => void denied.push(campaignId),
        noAccess: () => {
          throw new Error('unexpected');
        },
      },
      { nextBatch: async () => undefined, applyOutcomes: async () => undefined },
      async (input) => {
        requested.push(String(input));
        return String(input).includes(CAMPAIGN)
          ? new Response(null, { status: 404 })
          : Response.json({ endpoint: 'http://sync.test', token: 'token' });
      },
    );

    expect(await connector.fetchCredentials()).toEqual({
      endpoint: 'http://sync.test',
      token: 'token',
    });
    expect(denied).toEqual([CAMPAIGN]);
    expect(requested).toEqual([
      `/sync/bootstrap/${CAMPAIGN}?replicaId=${REPLICA}`,
      `/sync/bootstrap/${OTHER}?replicaId=${REPLICA}`,
    ]);
  });

  test('upload sends the registered batch and keeps the provider queue on a retryable outcome', async () => {
    const mutation = pendingMutation();
    let completed = 0;
    let served = 0;
    const applied: MutationOutcome[][] = [];
    const database = {
      getCrudBatch: async () => ({
        complete: async () => {
          completed += 1;
        },
      }),
    } as unknown as Parameters<RegisteredPowerSyncConnector['uploadData']>[0];
    const source = {
      nextBatch: async () =>
        served++ === 0
          ? { campaignId: CAMPAIGN, replicaId: REPLICA, mutations: [mutation] }
          : undefined,
      applyOutcomes: async (outcomes: readonly MutationOutcome[]) =>
        void applied.push([...outcomes]),
    };
    const respond = (outcome: MutationOutcome) =>
      new RegisteredPowerSyncConnector(
        {
          campaigns: async () => [],
          replicaId: async () => REPLICA,
          accessDenied: async () => undefined,
          noAccess: () => undefined,
        },
        source,
        async () => Response.json({ outcomes: [outcome] }),
      );

    await expect(
      respond({
        mutationId: mutation.mutationId,
        status: 'error',
        code: 'unavailable',
        retryable: true,
      }).uploadData(database),
    ).rejects.toThrow('sync_upload_retry');
    expect(completed).toBe(0);

    served = 0;
    await respond({
      mutationId: mutation.mutationId,
      status: 'accepted',
      acceptedVersion: 2,
      serverCursor: 'c2',
    }).uploadData(database);
    expect(completed).toBe(1);
    expect(applied.map((outcomes) => outcomes[0]?.status)).toEqual(['error', 'accepted']);
  });
});

describe('authority idempotency and semantic operations', () => {
  test('a stable mutation id is applied exactly once after a lost acknowledgement', async () => {
    let applications = 0;
    const registry = new MutationApplierRegistry();
    registry.register({
      featureId: 'entities',
      tableName: 'entities',
      apply: async () => {
        applications += 1;
        return { status: 'accepted', version: 2, cursor: 'cursor-2' };
      },
    });
    const authority = new AuthorityMutationService(
      { resolve: async () => ACTOR },
      registry,
      new InMemoryMutationReceiptStore(),
    );
    const mutation = pendingMutation({ mutationId: crypto.randomUUID() });
    const batch = { campaignId: CAMPAIGN, replicaId: REPLICA, mutations: [mutation] };
    const [first, retried] = await Promise.all([
      authority.apply(USER, batch),
      authority.apply(USER, batch),
    ]);
    expect(retried).toEqual(first);
    expect(applications).toBe(1);
  });

  test('rejects unregistered table operations and revoked actors', async () => {
    const authority = new AuthorityMutationService(
      { resolve: async () => undefined },
      new MutationApplierRegistry(),
      new InMemoryMutationReceiptStore(),
    );
    const outcomes = await authority.apply(USER, {
      campaignId: CAMPAIGN,
      replicaId: REPLICA,
      mutations: [pendingMutation()],
    });
    expect(outcomes[0]).toMatchObject({ status: 'error', code: 'not_found_or_forbidden' });
  });

  test('concurrent deltas merge and clamp while stale absolute set conflicts', async () => {
    const store = new InMemorySemanticAuthorityStore();
    const id = crypto.randomUUID();
    store.seed(id, { value: { resource: 6 }, version: 1 });
    const applier = new SemanticMutationApplier('characters', 'resources', store, () => 'cursor');
    await applier.apply({
      actor: ACTOR,
      mutation: pendingMutation({
        recordId: id,
        operation: 'semantic',
        expectedVersion: 1,
        payload: { operations: [{ op: 'delta', path: 'resource', value: -3 }] },
      }),
    });
    await applier.apply({
      actor: ACTOR,
      mutation: pendingMutation({
        recordId: id,
        operation: 'semantic',
        expectedVersion: 1,
        payload: { operations: [{ op: 'delta', path: 'resource', value: 2 }] },
      }),
    });
    expect(await store.get(id)).toEqual({ value: { resource: 5 }, version: 3 });
    const conflict = await applier.apply({
      actor: ACTOR,
      mutation: pendingMutation({
        recordId: id,
        operation: 'semantic',
        expectedVersion: 1,
        payload: { operations: [{ op: 'set', path: 'resource', value: 99 }] },
      }),
    });
    expect(conflict.status).toBe('conflict');
    expect(
      applySemanticOperations({ resource: 2 }, [
        { op: 'delta', path: 'resource', value: -3 },
        { op: 'clamp', path: 'resource', min: 0 },
      ]),
    ).toEqual({ resource: 0 });
  });
});

describe('holds, watermarks, status, and backend selection', () => {
  test('takeover removes old write authority and preserves its unsaved draft', async () => {
    let now = new Date('2026-08-31T10:00:00Z');
    const holds = new LongTextHoldService(new InMemoryLongTextHoldRepository(() => now));
    const field = {
      campaignId: CAMPAIGN,
      resourceClass: 'session_note',
      recordId: crypto.randomUUID(),
      fieldPath: 'body',
    };
    const first = await holds.acquire(field, { userId: USER, sessionId: SESSION });
    if ('heldBy' in first) throw new Error('fixture acquire failed');
    const notices: unknown[] = [];
    holds.notices.subscribe((notice) => notices.push(notice));
    const draft = new LongTextDraft('saved');
    draft.attachHold(first);
    draft.edit('unsaved local work');
    const second = await holds.takeover(field, {
      userId: crypto.randomUUID(),
      sessionId: crypto.randomUUID(),
    });
    const mayWrite = (expectedVersion: number, holderSessionId: string) =>
      holds.mayWriteWithin(undefined, { field, holderSessionId, expectedVersion });
    expect(await mayWrite(first.version, SESSION)).toBe(false);
    expect(await mayWrite(second.version, second.holderSessionId)).toBe(true);
    expect(second.version).toBe(2);
    expect(notices).toMatchObject([{ kind: 'taken_over', previousHolderUserId: USER, version: 2 }]);
    draft.loseHold();
    expect(draft.value).toBe('unsaved local work');

    now = new Date('2026-08-31T10:03:00Z');
    expect(await mayWrite(second.version, second.holderSessionId)).toBe(false);
    const third = await holds.acquire(field, { userId: USER, sessionId: SESSION });
    expect('heldBy' in third).toBe(false);
  });

  test('tombstone purge requires age, every eligible watermark, and no mutation reference', () => {
    const base = {
      campaignId: CAMPAIGN,
      tableName: 'entities',
      recordId: crypto.randomUUID(),
      sequence: 8,
      deletedAt: '2026-01-01T00:00:00Z',
      referencedByPendingMutation: false,
      subscribers: [
        { replicaId: REPLICA, eligibleAtDeletion: true, acknowledgedSequence: 8 },
        { replicaId: crypto.randomUUID(), eligibleAtDeletion: true, acknowledgedSequence: 7 },
      ],
    };
    const now = new Date('2026-08-31T00:00:00Z');
    expect(isTombstoneSafeToPurge(base, now)).toBe(false);
    expect(
      isTombstoneSafeToPurge(
        {
          ...base,
          subscribers: base.subscribers.map((item) => ({ ...item, revokedAt: now.toISOString() })),
        },
        now,
      ),
    ).toBe(true);
    expect(isTombstoneSafeToPurge({ ...base, referencedByPendingMutation: true }, now)).toBe(false);
  });

  test('status prioritizes error, offline, and pending over synchronized', () => {
    const status = new SyncStatusStore();
    status.setPendingCount(2);
    expect(status.snapshot().state).toBe('pending');
    status.setConnected(false);
    expect(status.snapshot().state).toBe('offline');
    status.setConnected(true);
    status.fail('upload_rejected');
    expect(status.snapshot().state).toBe('error');
  });

  test('uses OPFS when available and supports a forced IndexedDB fallback', () => {
    expect(selectBrowserStorageBackend({ opfsAvailable: true })).toBe('opfs');
    expect(selectBrowserStorageBackend({ force: 'indexeddb', opfsAvailable: true })).toBe(
      'indexeddb',
    );
  });
});

function pendingMutation(overrides: Partial<PendingMutation> = {}): PendingMutation {
  return {
    mutationId: crypto.randomUUID(),
    campaignId: CAMPAIGN,
    featureId: 'entities',
    tableName: 'entities',
    recordId: crypto.randomUUID(),
    operation: 'update',
    expectedVersion: 1,
    payload: { name: 'value' },
    causalSequence: 1,
    state: 'pending',
    attemptCount: 0,
    recordedAt: '2026-08-31T10:00:00Z',
    ...overrides,
  };
}

describe('audit envelope on the uploaded mutation (feature 06)', () => {
  const validBatch = (mutation: unknown) => ({
    campaignId: CAMPAIGN,
    replicaId: REPLICA,
    mutations: [mutation],
  });

  test('local write stores the validated payload and pending() carries it through restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rpg-sync-audit-'));
    tempDirectories.push(directory);
    const filename = join(directory, 'replica.sqlite');
    const first = new SqliteReplicaStore(filename);
    const id = crypto.randomUUID();
    const created = await repository(first).upsert(makeEntity(id, 'Audited'), null);
    expect(created.ok).toBe(true);
    first.close();

    const reopened = new SqliteReplicaStore(filename);
    const [pending] = reopened.pending(CAMPAIGN);
    expect(pending?.audit).toMatchObject({
      campaignId: CAMPAIGN,
      actor: ACTOR,
      action: 'entities.created',
      targetType: 'entities',
      targetId: id,
      after: { version: 1 },
      private: true, // the fixture entity is GM-only
    });
    // The uploaded envelope is exactly what the wire schema accepts.
    expect(Value.Check(MutationBatchSchema, validBatch(pending))).toBe(true);
    reopened.close();
  });

  test('tombstone and conflict resolution mutations carry valid payloads too', async () => {
    const store = new SqliteReplicaStore();
    const repo = repository(store);
    const id = crypto.randomUUID();
    const created = await repo.upsert(makeEntity(id, 'Doomed'), null);
    if (!created.ok) throw new Error('fixture create failed');
    expect((await repo.softDelete(id, created.value.version)).ok).toBe(true);
    const pending = store.pending(CAMPAIGN);
    expect(pending.map((item) => item.audit?.action)).toEqual([
      'entities.created',
      'entities.deleted',
    ]);

    const conflictStore = new SqliteReplicaStore();
    const conflicting = repository(conflictStore);
    const conflictId = crypto.randomUUID();
    const submitted = await conflicting.upsert(makeEntity(conflictId, 'Submitted'), null);
    if (!submitted.ok) throw new Error('fixture create failed');
    const [mutation] = conflictStore.pending(CAMPAIGN);
    if (mutation === undefined) throw new Error('fixture mutation missing');
    conflictStore.applyOutcomes(
      [
        {
          mutationId: mutation.mutationId,
          status: 'conflict',
          expectedVersion: 0,
          actualVersion: 3,
          currentValue: { ...submitted.value, name: 'Authority', version: 3 },
        },
      ],
      '2026-08-31T10:01:00Z',
    );
    const [conflict] = conflictStore.conflicts(CAMPAIGN);
    if (conflict === undefined) throw new Error('fixture conflict missing');
    const resolved = new ConflictResolutionService(
      conflictStore,
      new SyncStatusStore(),
      USER,
      () => new Date('2026-08-31T10:02:00Z'),
      () => crypto.randomUUID(),
    ).resolve({ conflictId: conflict.conflictId, choice: 'resubmit' });
    expect(resolved.ok).toBe(true);
    const [resolution] = conflictStore.pending(CAMPAIGN);
    expect(resolution?.operation).toBe('resolution');
    expect(resolution?.audit).toMatchObject({
      action: 'sync.conflict_resolved',
      targetId: conflictId,
      after: { conflictId: conflict.conflictId, choice: 'resubmit' },
    });
    expect(Value.Check(MutationBatchSchema, validBatch(resolution))).toBe(true);
  });

  test('an invalid payload fails the local write atomically', () => {
    const store = new SqliteReplicaStore();
    const entity = makeEntity(crypto.randomUUID(), 'Rejected');
    const audit = {
      campaignId: CAMPAIGN,
      actor: ACTOR,
      action: 'entities.created',
      targetType: 'entities',
      targetId: entity.id,
      at: '2026-10-24T10:00:00Z',
      private: false,
    };
    const write = (value: unknown) =>
      store.write({
        tableName: 'entities',
        featureId: 'entities',
        value: entity,
        expectedVersion: null,
        operation: 'insert',
        mutationId: crypto.randomUUID(),
        recordedAt: '2026-10-24T10:00:00Z',
        audit: value as typeof audit,
      });
    for (const invalid of [
      { ...audit, private: undefined },
      { ...audit, targetId: 'not-an-id' },
      { ...audit, extra: true },
      { ...audit, after: { blob: 'x'.repeat(16_385) } },
      null,
    ]) {
      expect(write(invalid)).toMatchObject({ ok: false, error: { code: 'validation_failed' } });
    }
    expect(store.pendingCount(CAMPAIGN)).toBe(0);
    expect(store.list('entities', CAMPAIGN, {})).toHaveLength(0);
    expect(write(audit).ok).toBe(true);
  });

  test('wire schema keeps older clients valid and refuses unknown audit properties', async () => {
    const store = new SqliteReplicaStore();
    await repository(store).upsert(makeEntity(crypto.randomUUID(), 'Wire'), null);
    const [pending] = store.pending(CAMPAIGN);
    if (pending === undefined) throw new Error('fixture mutation missing');
    const { audit, ...legacy } = pending;
    expect(audit).toBeDefined();
    expect(Value.Check(MutationBatchSchema, validBatch(legacy))).toBe(true);
    expect(
      Value.Check(
        MutationBatchSchema,
        validBatch({ ...pending, audit: { ...audit, id: SESSION } }),
      ),
    ).toBe(false);
    expect(
      Value.Check(
        MutationBatchSchema,
        validBatch({ ...pending, audit: { ...audit, actor: { ...ACTOR, extra: 1 } } }),
      ),
    ).toBe(false);
    expect(
      Value.Check(MutationBatchSchema, validBatch({ ...pending, audit: { ...audit, at: 'now' } })),
    ).toBe(false);
  });

  test('drained uploads include the envelope until the authority accepts it', async () => {
    const store = new SqliteReplicaStore();
    const status = new SyncStatusStore();
    const hub = new ConflictHub();
    const repo = new SqliteSyncedRepository(store, 'entities', 'entities', ACTOR, status, hub);
    await repo.upsert(makeEntity(crypto.randomUUID(), 'Retried'), null);
    const queue = new MutationQueue(store, status, hub);
    const uploaded: (string | undefined)[] = [];
    const upload = (outcome: 'retry' | 'accepted') => ({
      upload: async (batch: MutationBatch) => {
        uploaded.push(...batch.mutations.map((item) => item.audit?.action));
        return batch.mutations.map((item) =>
          outcome === 'retry'
            ? {
                mutationId: item.mutationId,
                status: 'error' as const,
                code: 'authority_unavailable',
                retryable: true,
              }
            : {
                mutationId: item.mutationId,
                status: 'accepted' as const,
                acceptedVersion: 1,
                serverCursor: 'c',
              },
        );
      },
    });
    await queue.drain(CAMPAIGN, REPLICA, upload('retry'));
    await queue.drain(CAMPAIGN, REPLICA, upload('accepted'));
    expect(uploaded).toEqual(['entities.created', 'entities.created']);
    expect(store.pending(CAMPAIGN)).toEqual([]);
  });
});
