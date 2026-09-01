import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeEntity, repositoryContractTests } from '@rpg/contracts/testing/repository-contract';
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
import type { PendingMutation } from './model.ts';
import {
  applySemanticOperations,
  InMemorySemanticAuthorityStore,
  SemanticMutationApplier,
} from './semantic.ts';
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
        2,
        'ALTER TABLE sync_campaign_state ADD COLUMN migration_probe TEXT',
        () => {
          throw new Error('injected migration failure');
        },
      ),
    ).toThrow('injected migration failure');
    expect(store.schemaVersion()).toBe(1);
    expect(store.pending(CAMPAIGN)).toEqual(before);
    store.close();
    const recovered = new SqliteReplicaStore(filename);
    expect(recovered.schemaVersion()).toBe(1);
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
    manager.revoke(CAMPAIGN);
    expect(store.list('entities', CAMPAIGN, {})).toHaveLength(0);
    expect(store.pendingCount(CAMPAIGN)).toBe(0);
  });

  test('bootstrap revocation drops the local campaign before reconnect continues', async () => {
    const store = new SqliteReplicaStore();
    const status = new SyncStatusStore();
    await repository(store).upsert(makeEntity(crypto.randomUUID(), 'Private'), null);
    const manager = new ReplicaManager(store, status);
    const connector = new RegisteredPowerSyncConnector(
      CAMPAIGN,
      { nextBatch: async () => undefined, applyOutcomes: async () => undefined },
      async () => new Response(null, { status: 404 }),
      () => manager.revoke(CAMPAIGN),
    );

    await expect(connector.fetchCredentials()).rejects.toThrow('sync_bootstrap_failed');
    expect(store.list('entities', CAMPAIGN, {})).toHaveLength(0);
    expect(store.pendingCount(CAMPAIGN)).toBe(0);
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
    expect(
      await holds.mayWrite({ field, holderSessionId: SESSION, expectedVersion: first.version }),
    ).toBe(false);
    expect(second.version).toBe(2);
    expect(notices).toMatchObject([{ kind: 'taken_over', previousHolderUserId: USER, version: 2 }]);
    draft.loseHold();
    expect(draft.value).toBe('unsaved local work');

    now = new Date('2026-08-31T10:03:00Z');
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
