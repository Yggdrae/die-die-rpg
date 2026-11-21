import { describe, expect, test } from 'bun:test';
import type { ActorRef } from '@rpg/contracts';
import { makeEntity } from '@rpg/contracts/testing/repository-contract';
import {
  AuthorityMutationService,
  InMemoryMutationReceiptStore,
  isCampaignCreation,
  MutationApplierRegistry,
} from './authority.ts';
import { ConflictHub, MutationQueue, SqliteSyncedRepository } from './bun-repository.ts';
import { SqliteReplicaStore } from './bun-sqlite.ts';
import type {
  ApplierOutcome,
  MutationApplier,
  MutationAuditHook,
  MutationAuditInput,
  MutationAuditParticipant,
  MutationAuditWithinInput,
  PendingMutation,
} from './model.ts';
import { SyncStatusStore } from './status.ts';
import { decideTombstonePurge } from './watermarks.ts';

const CAMPAIGN = '3f2504e0-4f89-41d3-9a0c-0305e82c3300';
const USER = '3f2504e0-4f89-41d3-9a0c-0305e82c3390';
const REPLICA = '3f2504e0-4f89-41d3-9a0c-0305e82c3392';
const ACTOR: ActorRef = { userId: USER, campaignId: CAMPAIGN, role: 'gm' };

function mutation(overrides: Partial<PendingMutation> = {}): PendingMutation {
  return {
    mutationId: crypto.randomUUID(),
    campaignId: CAMPAIGN,
    featureId: 'campaigns',
    tableName: 'campaigns',
    recordId: CAMPAIGN,
    operation: 'insert',
    expectedVersion: null,
    payload: {},
    causalSequence: 1,
    state: 'pending',
    attemptCount: 0,
    recordedAt: '2026-10-24T10:00:00Z',
    ...overrides,
  };
}

/** Membership appears only once a creation commits; `revoked` removes it. */
function authority(options: {
  readonly creation?: (creatorUserId: string) => Promise<ApplierOutcome>;
  readonly commitsMembership?: boolean;
}) {
  let member = false;
  const calls: string[] = [];
  const applier: MutationApplier = {
    featureId: 'campaigns',
    tableName: 'campaigns',
    apply: async ({ mutation: item }) => {
      calls.push(`apply:${item.operation}`);
      return { status: 'accepted', version: 2, cursor: `c-${item.causalSequence}` };
    },
    ...(options.creation === undefined
      ? {}
      : {
          applyCreation: async ({ creatorUserId }) => {
            calls.push(`create:${creatorUserId}`);
            const outcome = await (options.creation as (id: string) => Promise<ApplierOutcome>)(
              creatorUserId,
            );
            if (outcome.status === 'accepted' && options.commitsMembership !== false) member = true;
            return outcome;
          },
        }),
  };
  const registry = new MutationApplierRegistry();
  registry.register(applier);
  const service = new AuthorityMutationService(
    { resolve: async () => (member ? ACTOR : undefined) },
    registry,
    new InMemoryMutationReceiptStore(),
  );
  return {
    calls,
    apply: (...mutations: PendingMutation[]) =>
      service.apply(USER, { campaignId: CAMPAIGN, replicaId: REPLICA, mutations }),
    revoke: () => {
      member = false;
    },
  };
}

const accepted = async (): Promise<ApplierOutcome> => ({
  status: 'accepted',
  version: 1,
  cursor: 'created',
});

describe('access changed between authorization and commit', () => {
  const WRITE: ApplierOutcome = { status: 'accepted', version: 2, cursor: 'written' };
  const update = () => mutation({ operation: 'update', expectedVersion: 1 });

  function fenced(
    current: ActorRef | undefined,
    swallow?: ApplierOutcome,
    audit?: MutationAuditParticipant,
  ) {
    const handles: unknown[] = [];
    const written: unknown[] = [];
    const registry = new MutationApplierRegistry();
    registry.register({
      featureId: 'campaigns',
      tableName: 'campaigns',
      apply: async ({ recordAudit }) => {
        // The shape of a real applier: a throw here rolls its transaction back.
        const inTransaction = async () => {
          await recordAudit?.('transaction');
          written.push('committed');
          return WRITE;
        };
        if (swallow === undefined) return inTransaction();
        return inTransaction().catch(() => swallow);
      },
    });
    const receipts = new InMemoryMutationReceiptStore();
    const service = new AuthorityMutationService(
      {
        resolve: async () => ACTOR,
        resolveWithin: async (transaction) => {
          handles.push(transaction);
          return current;
        },
      },
      registry,
      receipts,
      audit,
    );
    return {
      handles,
      written,
      receipts,
      apply: (item: PendingMutation) =>
        service.apply(USER, { campaignId: CAMPAIGN, replicaId: REPLICA, mutations: [item] }),
    };
  }

  test('unchanged access: the write commits, checked on the applier transaction', async () => {
    const server = fenced(ACTOR);
    expect((await server.apply(update()))[0]).toMatchObject({ status: 'accepted' });
    expect(server.handles).toEqual(['transaction']);
    expect(server.written).toEqual(['committed']);
  });

  test('revoked: rolled back, terminal, and identical to any other denial', async () => {
    for (const swallow of [
      undefined,
      { status: 'error', code: 'authority_unavailable', retryable: true } as const,
    ]) {
      const server = fenced(undefined, swallow);
      const item = update();
      expect((await server.apply(item))[0]).toEqual({
        mutationId: item.mutationId,
        status: 'error',
        code: 'not_found_or_forbidden',
        retryable: false,
      });
      expect(server.written).toHaveLength(0);
      expect(await server.receipts.get(item.mutationId)).toBeDefined();
    }
  });

  test('role changed: rolled back and retryable, so no receipt pins the outcome', async () => {
    const server = fenced({ ...ACTOR, role: 'player' });
    const item = update();
    expect((await server.apply(item))[0]).toEqual({
      mutationId: item.mutationId,
      status: 'error',
      code: 'authority_unavailable',
      retryable: true,
    });
    expect(server.written).toHaveLength(0);
    expect(await server.receipts.get(item.mutationId)).toBeUndefined();
  });

  test('a lost access stores no audit event, in the transaction or after it', async () => {
    const recorded: unknown[] = [];
    const server = fenced(undefined, undefined, {
      recordMutationOutcome: async (input) => {
        recorded.push(input);
      },
      recordAcceptedWithin: async (_transaction, input) => {
        recorded.push(input);
        return true;
      },
    });
    const at = '2026-10-24T10:00:00Z';
    await server.apply({
      ...update(),
      audit: {
        campaignId: CAMPAIGN,
        action: 'campaign.updated',
        targetType: 'campaigns',
        targetId: CAMPAIGN,
        at,
        private: false,
      },
    });
    expect(recorded).toHaveLength(0);
  });

  test('a failed check aborts the write and stays retryable', async () => {
    const registry = new MutationApplierRegistry();
    registry.register({
      featureId: 'campaigns',
      tableName: 'campaigns',
      apply: async ({ recordAudit }) => {
        await recordAudit?.('transaction');
        return WRITE;
      },
    });
    const service = new AuthorityMutationService(
      {
        resolve: async () => ACTOR,
        resolveWithin: async () => {
          throw new Error('database unavailable');
        },
      },
      registry,
      new InMemoryMutationReceiptStore(),
    );
    const item = update();
    let thrown: unknown;
    try {
      await service.apply(USER, { campaignId: CAMPAIGN, replicaId: REPLICA, mutations: [item] });
    } catch (error) {
      thrown = error;
    }
    // Real appliers map this to `authority_unavailable`; what must not happen is an acceptance.
    expect(thrown).toBeInstanceOf(Error);
  });
});

describe('creation-scoped upload authorization', () => {
  test('only an unversioned insert of the campaign record itself qualifies', () => {
    expect(isCampaignCreation(mutation())).toBe(true);
    expect(isCampaignCreation(mutation({ operation: 'update', expectedVersion: 1 }))).toBe(false);
    expect(isCampaignCreation(mutation({ expectedVersion: 1 }))).toBe(false);
    expect(isCampaignCreation(mutation({ recordId: crypto.randomUUID() }))).toBe(false);
  });

  test('create commits, then later items resolve the new membership', async () => {
    const server = authority({ creation: accepted });
    const outcomes = await server.apply(
      mutation(),
      mutation({ operation: 'update', expectedVersion: 1, causalSequence: 2 }),
    );
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['accepted', 'accepted']);
    expect(server.calls).toEqual([`create:${USER}`, 'apply:update']);
  });

  test('fails closed without a creation-capable applier', async () => {
    const server = authority({});
    expect(await server.apply(mutation())).toEqual([
      expect.objectContaining({ status: 'error', code: 'not_found_or_forbidden' }),
    ]);
    expect(server.calls).toEqual([]);
  });

  test('fails closed when the creator does not resolve as a member after commit', async () => {
    const server = authority({ creation: accepted, commitsMembership: false });
    expect(await server.apply(mutation())).toEqual([
      expect.objectContaining({ status: 'error', code: 'not_found_or_forbidden' }),
    ]);
  });

  test('a creation conflict never exposes authority state to a non-member', async () => {
    const server = authority({
      creation: async () => ({
        status: 'conflict',
        expectedVersion: 1,
        actualVersion: 3,
        currentValue: { secret: 'gm-only' },
      }),
    });
    const [outcome] = await server.apply(mutation());
    expect(outcome).toEqual({
      mutationId: expect.any(String),
      status: 'error',
      code: 'not_found_or_forbidden',
      retryable: false,
    });
  });

  test('revoked uploads fail closed for every non-create item', async () => {
    const server = authority({ creation: accepted });
    await server.apply(mutation());
    server.revoke();
    const outcomes = await server.apply(
      mutation({ operation: 'update', expectedVersion: 1 }),
      mutation({ operation: 'tombstone', expectedVersion: 2, causalSequence: 2 }),
    );
    expect(outcomes).toEqual([
      expect.objectContaining({ code: 'not_found_or_forbidden' }),
      expect.objectContaining({ code: 'not_found_or_forbidden' }),
    ]);
  });

  test('a retryable authority failure is not persisted as the final receipt', async () => {
    let available = false;
    const server = authority({
      creation: async () =>
        available
          ? { status: 'accepted', version: 1, cursor: 'created' }
          : { status: 'error', code: 'authority_unavailable', retryable: true },
    });
    const item = mutation();
    expect((await server.apply(item))[0]).toMatchObject({ status: 'error', retryable: true });
    available = true;
    expect((await server.apply(item))[0]).toMatchObject({ status: 'accepted' });
    // Reconnect replay of the same mutation ID returns the stored acceptance, applied once.
    expect((await server.apply(item))[0]).toMatchObject({ status: 'accepted' });
    expect(server.calls.filter((call) => call.startsWith('create:'))).toHaveLength(2);
  });

  test('only one applier may own campaign creation', () => {
    const registry = new MutationApplierRegistry();
    const creator = (tableName: string): MutationApplier => ({
      featureId: 'campaigns',
      tableName,
      apply: accepted,
      applyCreation: accepted,
    });
    registry.register(creator('campaigns'));
    expect(() => registry.register(creator('other'))).toThrow('duplicate_creation_applier');
  });
});

describe('per-mutation drain outcomes', () => {
  function local() {
    const store = new SqliteReplicaStore();
    const status = new SyncStatusStore();
    const hub = new ConflictHub();
    const repo = new SqliteSyncedRepository(store, 'entities', 'entities', ACTOR, status, hub);
    return { store, status, repo, queue: new MutationQueue(store, status, hub) };
  }

  test('reports accepted, conflict, rejected, and retry in causal order', async () => {
    const device = local();
    for (const name of ['a', 'b', 'c', 'd']) {
      await device.repo.upsert(makeEntity(crypto.randomUUID(), name), null);
    }
    const report = await device.queue.drainWithOutcomes(CAMPAIGN, REPLICA, {
      upload: async (batch) => {
        const [a, b, c, d] = batch.mutations.map((item) => item.mutationId);
        return [
          {
            mutationId: a as string,
            status: 'accepted',
            acceptedVersion: 1,
            serverCursor: 'x',
          },
          {
            mutationId: b as string,
            status: 'conflict',
            expectedVersion: 1,
            actualVersion: 2,
            currentValue: null,
          },
          { mutationId: c as string, status: 'error', code: 'forbidden', retryable: false },
          { mutationId: d as string, status: 'error', code: 'unavailable', retryable: true },
        ];
      },
    });
    expect(report.state).toBe('uploaded');
    expect(report.outcomes.map((item) => item.result)).toEqual([
      'accepted',
      'conflict',
      'rejected',
      'retry',
    ]);
    expect(report.outcomes.every((item) => item.tableName === 'entities')).toBe(true);
    expect(report.conflicts).toHaveLength(1);
    expect(device.store.pending(CAMPAIGN).map((item) => item.mutationId)).toEqual([
      report.outcomes[3]?.mutationId as string,
    ]);
  });

  test('offline, transport failure, and mismatched outcomes report no item outcome', async () => {
    const device = local();
    await device.repo.upsert(makeEntity(crypto.randomUUID(), 'queued'), null);
    device.status.setConnected(false);
    const never = {
      upload: async () => {
        throw new Error('must not upload');
      },
    };
    expect((await device.queue.drainWithOutcomes(CAMPAIGN, REPLICA, never)).state).toBe('offline');
    device.status.setConnected(true);
    expect((await device.queue.drainWithOutcomes(CAMPAIGN, REPLICA, never)).state).toBe(
      'transport_error',
    );
    const mismatched = await device.queue.drainWithOutcomes(CAMPAIGN, REPLICA, {
      upload: async () => [
        { mutationId: crypto.randomUUID(), status: 'error', code: 'x', retryable: false },
      ],
    });
    expect(mismatched).toEqual({ state: 'invalid_outcome', outcomes: [], conflicts: [] });
    expect(device.store.pendingCount(CAMPAIGN)).toBe(1);
  });
});

describe('tombstone purge decision contract', () => {
  test('names each blocker; safe only when all three rules hold', () => {
    const now = new Date('2026-10-24T00:00:00Z');
    const base = {
      campaignId: CAMPAIGN,
      tableName: 'campaigns',
      recordId: crypto.randomUUID(),
      sequence: 5,
      deletedAt: '2026-01-01T00:00:00Z',
      referencedByPendingMutation: false,
      subscribers: [
        { replicaId: REPLICA, eligibleAtDeletion: true, acknowledgedSequence: 5 },
        { replicaId: crypto.randomUUID(), eligibleAtDeletion: false, acknowledgedSequence: 0 },
      ],
    };
    expect(decideTombstonePurge(base, now)).toEqual({ safe: true });
    expect(
      decideTombstonePurge(
        {
          ...base,
          deletedAt: '2026-10-01T00:00:00Z',
          referencedByPendingMutation: true,
          subscribers: [{ replicaId: REPLICA, eligibleAtDeletion: true, acknowledgedSequence: 4 }],
        },
        now,
      ),
    ).toEqual({
      safe: false,
      blockers: ['minimum_age', 'unacknowledged_replica', 'pending_mutation_reference'],
    });
  });
});

describe('audit participant (feature 06 mutation envelope)', () => {
  const FORGED = '3f2504e0-4f89-41d3-9a0c-0305e82c3999';
  const audit = {
    campaignId: FORGED,
    actor: { userId: FORGED, campaignId: FORGED, role: 'owner' as const },
    action: 'campaigns.updated',
    targetType: 'forged_table',
    targetId: FORGED,
    after: { version: 2 },
    at: '2026-10-24T10:00:00Z',
    private: false,
  };

  /** Accepted-only, idempotent by mutation ID: the shape every participant must have. */
  function recorder() {
    const events = new Map<string, MutationAuditInput>();
    const calls: MutationAuditInput[] = [];
    const participant: MutationAuditParticipant = {
      recordMutationOutcome: async (input) => {
        calls.push(input);
        if (input.outcome.status === 'accepted' && !events.has(input.mutationId)) {
          events.set(input.mutationId, input);
        }
      },
    };
    return { events, calls, participant };
  }

  function harness(
    participant: MutationAuditParticipant | undefined,
    outcome: () => ApplierOutcome = () => ({ status: 'accepted', version: 2, cursor: 'c' }),
  ) {
    const receipts = new InMemoryMutationReceiptStore();
    const applied: string[] = [];
    const registry = new MutationApplierRegistry();
    registry.register({
      featureId: 'campaigns',
      tableName: 'campaigns',
      apply: async ({ mutation: item }) => {
        applied.push(item.mutationId);
        return outcome();
      },
    });
    const service = new AuthorityMutationService(
      { resolve: async () => ACTOR },
      registry,
      receipts,
      participant,
    );
    return {
      receipts,
      applied,
      apply: (...mutations: PendingMutation[]) =>
        service.apply(USER, { campaignId: CAMPAIGN, replicaId: REPLICA, mutations }),
    };
  }

  const update = (overrides: Partial<PendingMutation> = {}) =>
    mutation({ operation: 'update', expectedVersion: 1, audit, ...overrides });

  test('origin ID is the mutation ID; payload is bound to the mutation and resolved actor', async () => {
    const log = recorder();
    const server = harness(log.participant);
    const item = update();
    const [outcome] = await server.apply(item);
    expect(outcome).toMatchObject({ status: 'accepted' });
    expect(log.calls).toHaveLength(1);
    expect(log.calls[0]).toMatchObject({
      mutationId: item.mutationId,
      outcome: { status: 'accepted', mutationId: item.mutationId },
      audit: {
        campaignId: CAMPAIGN,
        actor: ACTOR,
        targetType: 'campaigns',
        targetId: CAMPAIGN,
        action: 'campaigns.updated',
        after: { version: 2 },
      },
    });
  });

  test('participant runs after the applier result and receipt are durable', async () => {
    const receipts = new InMemoryMutationReceiptStore();
    const seen: string[] = [];
    const registry = new MutationApplierRegistry();
    registry.register({
      featureId: 'campaigns',
      tableName: 'campaigns',
      apply: async () => {
        seen.push('applied');
        return { status: 'accepted', version: 2, cursor: 'c' };
      },
    });
    const item = update();
    const service = new AuthorityMutationService(
      { resolve: async () => ACTOR },
      registry,
      receipts,
      {
        recordMutationOutcome: async () => {
          seen.push(`receipt:${(await receipts.get(item.mutationId))?.status}`);
        },
      },
    );
    await service.apply(USER, { campaignId: CAMPAIGN, replicaId: REPLICA, mutations: [item] });
    expect(seen).toEqual(['applied', 'receipt:accepted']);
  });

  test('lost acknowledgement: resubmit applies once and still yields exactly one event', async () => {
    const log = recorder();
    const server = harness(log.participant);
    const item = update();
    await server.apply(item);
    await server.apply(item);
    await server.apply(item);
    expect(server.applied).toEqual([item.mutationId]);
    expect(log.calls).toHaveLength(3);
    expect(log.events.size).toBe(1);
  });

  test('retryable failure then success stores exactly one accepted event', async () => {
    const log = recorder();
    let available = false;
    const server = harness(log.participant, () =>
      available
        ? { status: 'accepted', version: 2, cursor: 'c' }
        : { status: 'error', code: 'authority_unavailable', retryable: true },
    );
    const item = update();
    expect((await server.apply(item))[0]).toMatchObject({ status: 'error', retryable: true });
    available = true;
    await server.apply(item);
    await server.apply(item);
    expect(log.events.size).toBe(1);
    expect([...log.events.keys()]).toEqual([item.mutationId]);
  });

  test('conflict and terminal rejection create no accepted history', async () => {
    const log = recorder();
    const conflicted = harness(log.participant, () => ({
      status: 'conflict',
      expectedVersion: 1,
      actualVersion: 3,
      currentValue: {},
    }));
    const rejected = harness(log.participant, () => ({
      status: 'error',
      code: 'forbidden',
      retryable: false,
    }));
    await conflicted.apply(update());
    await rejected.apply(update());
    expect(log.calls.map((call) => call.outcome.status)).toEqual(['conflict', 'error']);
    expect(log.events.size).toBe(0);
  });

  test('an unavailable or throwing audit adapter never changes the user outcome', async () => {
    const throwing = harness({
      recordMutationOutcome: async () => {
        throw new Error('audit adapter down: hidden-gm-note');
      },
    });
    const item = update();
    expect((await throwing.apply(item))[0]).toMatchObject({ status: 'accepted' });
    expect((await throwing.receipts.get(item.mutationId))?.status).toBe('accepted');
    expect((await throwing.apply(item))[0]).toMatchObject({ status: 'accepted' });
    expect(throwing.applied).toHaveLength(1);
  });

  test('mutations without an envelope, or services without a participant, are not audited here', async () => {
    const log = recorder();
    await harness(log.participant).apply(update({ audit: undefined }));
    expect(log.calls).toHaveLength(0);
    const [outcome] = await harness(undefined).apply(update());
    expect(outcome).toMatchObject({ status: 'accepted' });
  });

  test('denied items never reach the participant', async () => {
    const log = recorder();
    const service = new AuthorityMutationService(
      { resolve: async () => undefined },
      new MutationApplierRegistry(),
      new InMemoryMutationReceiptStore(),
      log.participant,
    );
    const [outcome] = await service.apply(USER, {
      campaignId: CAMPAIGN,
      replicaId: REPLICA,
      mutations: [update()],
    });
    expect(outcome).toMatchObject({ status: 'error', code: 'not_found_or_forbidden' });
    expect(log.calls).toHaveLength(0);
  });

  test('creation uses the actor resolved after the owner membership commits', async () => {
    const log = recorder();
    let member = false;
    const registry = new MutationApplierRegistry();
    registry.register({
      featureId: 'campaigns',
      tableName: 'campaigns',
      apply: accepted,
      applyCreation: async () => {
        member = true;
        return { status: 'accepted', version: 1, cursor: 'created' };
      },
    });
    const service = new AuthorityMutationService(
      { resolve: async () => (member ? ACTOR : undefined) },
      registry,
      new InMemoryMutationReceiptStore(),
      log.participant,
    );
    const item = mutation({ audit });
    await service.apply(USER, { campaignId: CAMPAIGN, replicaId: REPLICA, mutations: [item] });
    expect(log.events.get(item.mutationId)?.audit.actor).toEqual(ACTOR);
  });
});

describe('audit inside the applier transaction (feature 06 task 02, _db.md Write Path)', () => {
  const FORGED = '3f2504e0-4f89-41d3-9a0c-0305e82c3998';
  const audit = {
    campaignId: FORGED,
    actor: { userId: FORGED, campaignId: FORGED, role: 'owner' as const },
    action: 'campaigns.updated',
    targetType: 'forged_table',
    targetId: FORGED,
    after: { version: 2 },
    at: '2026-10-26T10:00:00Z',
    private: false,
  };

  /**
   * A fake domain store whose transaction is a staging map: what the hook stages commits only
   * when the write succeeds, exactly like a PostgreSQL transaction.
   */
  function world(
    options: {
      readonly within?: (input: MutationAuditWithinInput) => Promise<boolean>;
      readonly callsHook?: number;
      readonly withinSupported?: boolean;
    } = {},
  ) {
    const committed = new Map<string, MutationAuditWithinInput>();
    const afterCommit: MutationAuditInput[] = [];
    const handles: unknown[] = [];
    let failAfterAudit = false;
    let conflict = false;
    const participant: MutationAuditParticipant = {
      recordMutationOutcome: async (input) => {
        afterCommit.push(input);
        if (input.outcome.status === 'accepted' && !committed.has(input.mutationId)) {
          committed.set(input.mutationId, { mutationId: input.mutationId, audit: input.audit });
        }
      },
      ...(options.withinSupported === false
        ? {}
        : {
            recordAcceptedWithin: async (transaction: unknown, input: MutationAuditWithinInput) => {
              handles.push(transaction);
              if (options.within !== undefined && !(await options.within(input))) return false;
              (transaction as Map<string, MutationAuditWithinInput>).set(input.mutationId, input);
              return true;
            },
          }),
    };
    const write = async (hook: MutationAuditHook | undefined): Promise<ApplierOutcome> => {
      if (conflict) {
        return { status: 'conflict', expectedVersion: 1, actualVersion: 2, currentValue: {} };
      }
      const transaction = new Map<string, MutationAuditWithinInput>();
      for (let call = 0; call < (options.callsHook ?? 1); call += 1) await hook?.(transaction);
      if (failAfterAudit) {
        failAfterAudit = false;
        return { status: 'error', code: 'authority_unavailable', retryable: true };
      }
      for (const [key, value] of transaction) committed.set(key, value);
      return { status: 'accepted', version: 2, cursor: 'c' };
    };
    let member = true;
    const registry = new MutationApplierRegistry();
    registry.register({
      featureId: 'campaigns',
      tableName: 'campaigns',
      apply: async ({ recordAudit }) => write(recordAudit),
      applyCreation: async ({ recordAudit }) => {
        const outcome = await write(recordAudit);
        member = true;
        return outcome;
      },
    });
    const service = new AuthorityMutationService(
      { resolve: async () => (member ? ACTOR : undefined) },
      registry,
      new InMemoryMutationReceiptStore(),
      participant,
    );
    return {
      committed,
      afterCommit,
      handles,
      failNextAfterAudit: () => {
        failAfterAudit = true;
      },
      conflictNext: () => {
        conflict = true;
      },
      revokeMembership: () => {
        member = false;
      },
      apply: (...mutations: PendingMutation[]) =>
        service.apply(USER, { campaignId: CAMPAIGN, replicaId: REPLICA, mutations }),
    };
  }

  const update = (overrides: Partial<PendingMutation> = {}) =>
    mutation({ operation: 'update', expectedVersion: 1, audit, ...overrides });

  test('the event commits with the write under the mutation ID, bound to mutation and actor', async () => {
    const server = world();
    const item = update();
    expect((await server.apply(item))[0]).toMatchObject({ status: 'accepted' });
    expect([...server.committed.values()]).toEqual([
      {
        mutationId: item.mutationId,
        audit: {
          ...audit,
          campaignId: CAMPAIGN,
          targetType: 'campaigns',
          targetId: CAMPAIGN,
          actor: ACTOR,
        },
      },
    ]);
    expect(server.afterCommit).toHaveLength(0);
  });

  test('a write that fails after the audit insert rolls both back; the retry records one event', async () => {
    const server = world();
    const item = update();
    server.failNextAfterAudit();
    expect((await server.apply(item))[0]).toMatchObject({ status: 'error', retryable: true });
    expect(server.committed.size).toBe(0);
    // Held by the rolled-back transaction: a failed write gets no after-commit recording.
    expect(server.afterCommit).toHaveLength(0);
    expect((await server.apply(item))[0]).toMatchObject({ status: 'accepted' });
    expect((await server.apply(item))[0]).toMatchObject({ status: 'accepted' });
    expect([...server.committed.keys()]).toEqual([item.mutationId]);
    // Only the lost-acknowledgement replay reached the idempotent after-commit path.
    expect(server.afterCommit.map((call) => call.outcome.status)).toEqual(['accepted']);
  });

  test('a participant that cannot hold the event, or throws, falls back after commit', async () => {
    for (const within of [
      async () => false,
      async () => {
        throw new Error('audit adapter down: hidden-gm-note');
      },
    ]) {
      const server = world({ within });
      const item = update();
      expect((await server.apply(item))[0]).toMatchObject({ status: 'accepted' });
      expect(server.handles).toHaveLength(1);
      expect(server.afterCommit.map((call) => call.outcome.status)).toEqual(['accepted']);
      expect([...server.committed.keys()]).toEqual([item.mutationId]);
    }
  });

  test('an applier that never calls the hook, or a participant without it, records after commit', async () => {
    for (const server of [world({ callsHook: 0 }), world({ withinSupported: false })]) {
      const item = update();
      expect((await server.apply(item))[0]).toMatchObject({ status: 'accepted' });
      expect(server.handles).toHaveLength(0);
      expect(server.afterCommit.map((call) => call.outcome.status)).toEqual(['accepted']);
      expect([...server.committed.keys()]).toEqual([item.mutationId]);
    }
  });

  test('a hook called twice records once', async () => {
    const server = world({ callsHook: 2 });
    await server.apply(update());
    expect(server.handles).toHaveLength(1);
    expect(server.committed.size).toBe(1);
  });

  test('conflicts, mutations without an envelope, and denied items create no history', async () => {
    const server = world();
    server.conflictNext();
    expect((await server.apply(update()))[0]).toMatchObject({ status: 'conflict' });
    expect((await server.apply(update({ audit: undefined })))[0]).toMatchObject({
      status: 'conflict',
    });
    expect(server.handles).toHaveLength(0);
    expect(server.committed.size).toBe(0);
    expect(server.afterCommit.map((call) => call.outcome.status)).toEqual(['conflict']);

    const denied = world();
    denied.revokeMembership();
    expect((await denied.apply(update()))[0]).toMatchObject({ code: 'not_found_or_forbidden' });
    expect(denied.handles).toHaveLength(0);
    expect(denied.committed.size).toBe(0);
  });

  test('creation records the creator as owner inside the creating transaction', async () => {
    const server = world();
    server.revokeMembership();
    const item = mutation({ audit });
    expect((await server.apply(item))[0]).toMatchObject({ status: 'accepted' });
    expect(server.committed.get(item.mutationId)?.audit.actor).toEqual({
      userId: USER,
      campaignId: CAMPAIGN,
      role: 'owner',
    });
    expect(server.afterCommit).toHaveLength(0);
  });
});

describe('B-2 session and server-authored audit (feature 16 task 06)', () => {
  const envelope = {
    campaignId: CAMPAIGN,
    action: 'content.updated',
    targetType: 'content_entities',
    targetId: CAMPAIGN,
    before: { description: 'client text' },
    after: { description: 'client text' },
    at: '2026-10-28T10:00:00.000Z',
    private: true,
  };
  const authored = {
    action: 'entity.updated',
    targetType: 'campaign_entity',
    before: { name: 'A' },
    after: { name: 'B', changed: ['description'] },
    targetVisibility: { visibility: { mode: 'gm_only' as const } },
  };

  function harness(behavior: (hook: MutationAuditHook | undefined) => Promise<void>) {
    const sessions: (string | undefined)[] = [];
    const within: MutationAuditWithinInput[] = [];
    const afterCommit: MutationAuditInput[] = [];
    let holds = true;
    const registry = new MutationApplierRegistry();
    registry.register({
      featureId: 'content',
      tableName: 'content_entities',
      apply: async ({ sessionId, recordAudit }) => {
        sessions.push(sessionId);
        await behavior(recordAudit);
        return { status: 'accepted', version: 2, cursor: 'c' };
      },
    });
    const participant: MutationAuditParticipant = {
      recordMutationOutcome: async (input) => void afterCommit.push(input),
      recordAcceptedWithin: async (_transaction, input) => {
        within.push(input);
        return holds;
      },
    };
    const service = new AuthorityMutationService(
      { resolve: async () => ACTOR },
      registry,
      new InMemoryMutationReceiptStore(),
      participant,
    );
    const item = () =>
      mutation({
        featureId: 'content',
        tableName: 'content_entities',
        operation: 'update',
        expectedVersion: 1,
        audit: envelope,
      });
    return {
      sessions,
      within,
      afterCommit,
      refuse: () => {
        holds = false;
      },
      apply: (sessionId?: string) =>
        service.apply(
          USER,
          { campaignId: CAMPAIGN, replicaId: REPLICA, mutations: [item()] },
          sessionId === undefined ? {} : { sessionId },
        ),
    };
  }

  test('the route-supplied session reaches the applier; absent stays absent', async () => {
    const h = harness(async () => undefined);
    await h.apply('3f2504e0-4f89-41d3-9a0c-0305e82c33aa');
    await h.apply();
    expect(h.sessions).toEqual(['3f2504e0-4f89-41d3-9a0c-0305e82c33aa', undefined]);
  });

  test('an authored event replaces every client-composed field; the binding stays', async () => {
    const h = harness(async (hook) => hook?.({ execute: () => undefined }, authored));
    await h.apply();
    expect(h.within).toHaveLength(1);
    expect(h.within[0]?.audit).toEqual({
      campaignId: CAMPAIGN,
      actor: ACTOR,
      action: 'entity.updated',
      targetType: 'campaign_entity',
      targetId: CAMPAIGN,
      before: { name: 'A' },
      after: { name: 'B', changed: ['description'] },
      at: envelope.at,
      private: false,
    });
    expect(h.within[0]?.targetVisibility).toEqual(authored.targetVisibility);
    expect(h.afterCommit).toEqual([]);
  });

  test('a participant that cannot hold an authored event records the authored event after commit', async () => {
    const h = harness(async (hook) => hook?.({ execute: () => undefined }, authored));
    h.refuse();
    await h.apply();
    expect(h.afterCommit).toHaveLength(1);
    expect(h.afterCommit[0]?.audit.action).toBe('entity.updated');
    expect(h.afterCommit[0]?.audit.targetType).toBe('campaign_entity');
    expect(JSON.stringify(h.afterCommit[0])).not.toContain('client text');
    expect(h.afterCommit[0]?.targetVisibility).toEqual(authored.targetVisibility);
  });
});
