import { describe, expect, test } from 'bun:test';
import {
  type AccountAuditEnvelope,
  type AuditAppender,
  type AuditAppendResult,
  type AuditEnvelope,
  type AuditFailureSignal,
  type AuditParkInput,
  AuditRendererRegistry,
  type AuditRepairEntry,
  type AuditRepairOutbox,
  type AuditSqlExecutor,
  type CampaignAuditEnvelope,
  DurableAuditRecorder,
  MAX_AUDIT_VALUE_BYTES,
  type TargetVisibilitySnapshot,
} from '@rpg/audit';
import {
  AUTHOR_PRIVATE_NOTE_FIXTURE,
  type ResourcePolicy,
  ResourcePolicyRegistry,
} from '@rpg/authorization';
import type { ActorRef, AuditEvent } from '@rpg/contracts';
import {
  InvitationService,
  type InvitationStore,
  type MembershipRecord,
  MembershipService,
  type MembershipStore,
} from '@rpg/identity';
import {
  AuthorityMutationService,
  InMemoryMutationReceiptStore,
  MUTATION_AUDIT_VALUE_LIMIT_BYTES,
  MutationApplierRegistry,
  type PendingMutation,
} from '@rpg/sync';
import { registerResourcePolicies } from '../sync/sync-rules.ts';
import {
  auditTargetDeclarationsFor,
  membershipAuditOriginId,
  membershipAuditRecorderFor,
  mutationAuditParticipantFor,
  recordOnlyMutationAuditParticipant,
} from './composition.ts';

const SECRET = 'hidden-gm-note';
const CAMPAIGN = '0198f702-4be0-7000-8000-0000000000c1';
const USER = '0198f702-4be0-7000-8000-0000000000a1';
const REPLICA = '0198f702-4be0-7000-8000-0000000000d1';
const ACTOR: ActorRef = { userId: USER, campaignId: CAMPAIGN, role: 'gm' };

class FakeStore implements AuditAppender<CampaignAuditEnvelope> {
  readonly rows = new Map<string, CampaignAuditEnvelope>();
  down = false;
  /** Store the row, then fail: the acknowledgement is lost. */
  loseAckNext = 0;

  async append(envelope: CampaignAuditEnvelope): Promise<AuditAppendResult> {
    if (this.down) throw new Error(`store down ${SECRET}`);
    const existing = this.rows.get(envelope.originMutationId);
    if (existing === undefined) this.rows.set(envelope.originMutationId, envelope);
    if (this.loseAckNext > 0) {
      this.loseAckNext -= 1;
      throw new Error('acknowledgement lost');
    }
    return existing === undefined
      ? { status: 'inserted', eventId: envelope.eventId, sequence: this.rows.size }
      : { status: 'duplicate', eventId: existing.eventId, sequence: 1 };
  }

  appendWithin(_executor: unknown, envelope: CampaignAuditEnvelope): Promise<AuditAppendResult> {
    return this.append(envelope);
  }
}

class FakeAccountStore implements AuditAppender<AccountAuditEnvelope> {
  async append(envelope: AccountAuditEnvelope): Promise<AuditAppendResult> {
    return { status: 'inserted', eventId: envelope.eventId, sequence: 1 };
  }
  appendWithin(_executor: unknown, envelope: AccountAuditEnvelope) {
    return this.append(envelope);
  }
}

class FakeOutbox implements AuditRepairOutbox {
  readonly entries = new Map<string, AuditParkInput & { resolved: boolean }>();
  down = false;

  async park(input: AuditParkInput): Promise<void> {
    if (this.down) throw new Error('outbox down');
    this.entries.set(input.envelope.eventId, { ...input, resolved: false });
  }
  parkWithin(_executor: unknown, input: AuditParkInput): Promise<void> {
    return this.park(input);
  }
  async due(now: Date): Promise<readonly AuditRepairEntry[]> {
    if (this.down) throw new Error('outbox down');
    return [...this.entries.values()]
      .filter((entry) => entry.state === 'pending' && !entry.resolved)
      .filter((entry) => entry.nextAttemptAt.getTime() <= now.getTime())
      .map((entry) => ({
        envelope: entry.envelope as AuditEnvelope,
        attemptCount: entry.attemptCount,
      }));
  }
  async resolve(eventId: string): Promise<void> {
    const entry = this.entries.get(eventId);
    if (entry !== undefined) entry.resolved = true;
  }
  async backlog() {
    const open = [...this.entries.values()].filter((entry) => !entry.resolved);
    return {
      pending: open.filter((entry) => entry.state === 'pending').length,
      dead: open.filter((entry) => entry.state === 'dead').length,
    };
  }
}

function mutation(overrides: Partial<PendingMutation> = {}): PendingMutation {
  return {
    mutationId: crypto.randomUUID(),
    campaignId: CAMPAIGN,
    featureId: 'campaigns',
    tableName: 'campaigns',
    recordId: CAMPAIGN,
    operation: 'update',
    expectedVersion: 1,
    payload: {},
    audit: {
      campaignId: CAMPAIGN,
      action: 'campaigns.updated',
      targetType: 'campaigns',
      targetId: CAMPAIGN,
      before: { note: SECRET },
      after: { note: SECRET },
      at: '2026-10-24T12:00:00Z',
      private: false,
    },
    causalSequence: 1,
    state: 'pending',
    attemptCount: 0,
    recordedAt: '2026-10-24T12:00:00Z',
    ...overrides,
  };
}

function harness(result: () => 'accepted' | 'conflict' | 'rejected' = () => 'accepted') {
  const campaign = new FakeStore();
  const privateStore = new FakeStore();
  const outbox = new FakeOutbox();
  const signals: { kind: string; signal: unknown }[] = [];
  const recorder = new DurableAuditRecorder({
    campaign,
    private: privateStore,
    account: new FakeAccountStore(),
    outbox,
    registry: new AuditRendererRegistry(),
    diagnostics: {
      degraded: (signal: AuditFailureSignal) => signals.push({ kind: 'degraded', signal }),
      deadLettered: (signal: AuditFailureSignal) => signals.push({ kind: 'deadLettered', signal }),
      repaired: (signal) => signals.push({ kind: 'repaired', signal }),
    },
    options: { baseDelayMs: 0, attemptTimeoutMs: 50 },
  });
  const registry = new MutationApplierRegistry();
  const applied: string[] = [];
  registry.register({
    featureId: 'campaigns',
    tableName: 'campaigns',
    apply: async ({ mutation: item }) => {
      applied.push(item.mutationId);
      const outcome = result();
      if (outcome === 'accepted') return { status: 'accepted', version: 2, cursor: 'c' };
      if (outcome === 'conflict') {
        return { status: 'conflict', expectedVersion: 1, actualVersion: 2, currentValue: {} };
      }
      return { status: 'error', code: 'forbidden', retryable: false };
    },
  });
  const service = new AuthorityMutationService(
    { resolve: async () => ACTOR },
    registry,
    new InMemoryMutationReceiptStore(),
    mutationAuditParticipantFor(recorder),
  );
  return {
    campaign,
    privateStore,
    outbox,
    recorder,
    signals,
    applied,
    upload: (...mutations: PendingMutation[]) =>
      service.apply(USER, { campaignId: CAMPAIGN, replicaId: REPLICA, mutations }),
  };
}

describe('sync envelope to durable audit recorder', () => {
  test('local and wire audit bound mirrors the recorder bound', () => {
    expect(MUTATION_AUDIT_VALUE_LIMIT_BYTES).toBe(MAX_AUDIT_VALUE_BYTES);
  });

  test('accepted mutation stores one event whose origin ID is the mutation ID', async () => {
    const server = harness();
    const item = mutation();
    const [outcome] = await server.upload(item);
    expect(outcome).toMatchObject({ status: 'accepted' });
    expect([...server.campaign.rows.keys()]).toEqual([item.mutationId]);
    const stored = server.campaign.rows.get(item.mutationId);
    expect(stored?.event).toMatchObject({
      campaignId: CAMPAIGN,
      actor: ACTOR,
      targetType: 'campaigns',
      targetId: CAMPAIGN,
    } satisfies Partial<AuditEvent>);
    expect(server.privateStore.rows.size).toBe(0);
  });

  test('private events route to the private store only', async () => {
    const server = harness();
    const item = mutation();
    await server.upload({ ...item, audit: item.audit && { ...item.audit, private: true } });
    expect(server.campaign.rows.size).toBe(0);
    expect(server.privateStore.rows.size).toBe(1);
  });

  test('lost acknowledgement and resubmits store exactly one event', async () => {
    const server = harness();
    const item = mutation();
    server.campaign.loseAckNext = 1;
    expect((await server.upload(item))[0]).toMatchObject({ status: 'accepted' });
    expect(server.campaign.rows.size).toBe(1);
    await server.upload(item);
    await server.upload(item);
    await server.recorder.retryPending();
    expect(server.campaign.rows.size).toBe(1);
    expect(server.applied).toEqual([item.mutationId]);
  });

  test('unavailable audit store never rejects the mutation; retry stores one event', async () => {
    const server = harness();
    const item = mutation();
    server.campaign.down = true;
    expect((await server.upload(item))[0]).toMatchObject({ status: 'accepted' });
    expect(server.campaign.rows.size).toBe(0);
    expect(await server.recorder.backlog()).toMatchObject({ outboxPending: 1 });

    // A resubmit while the store is still down cannot duplicate or reject either.
    expect((await server.upload(item))[0]).toMatchObject({ status: 'accepted' });
    server.campaign.down = false;
    const report = await server.recorder.retryPending();
    expect(report.repaired).toBeGreaterThanOrEqual(1);
    expect([...server.campaign.rows.keys()]).toEqual([item.mutationId]);
    expect(await server.recorder.backlog()).toMatchObject({ outboxPending: 0 });
  });

  test('store and outbox both down: the mutation is still accepted and the gap is signalled', async () => {
    const server = harness();
    server.campaign.down = true;
    server.outbox.down = true;
    const item = mutation();
    expect((await server.upload(item))[0]).toMatchObject({ status: 'accepted' });
    expect(server.signals.map((entry) => entry.kind)).toContain('degraded');
    server.campaign.down = false;
    server.outbox.down = false;
    await server.recorder.retryPending();
    expect(server.campaign.rows.size).toBe(1);
  });

  test('conflict and rejection create no accepted history', async () => {
    const conflicted = harness(() => 'conflict');
    const rejected = harness(() => 'rejected');
    await conflicted.upload(mutation());
    await rejected.upload(mutation());
    for (const server of [conflicted, rejected]) {
      expect(server.campaign.rows.size).toBe(0);
      expect(server.privateStore.rows.size).toBe(0);
      expect(server.outbox.entries.size).toBe(0);
      expect(server.signals).toEqual([]);
    }
  });

  test('an invalid envelope is dead-lettered without blocking or leaking its payload', async () => {
    const server = harness();
    const item = mutation();
    const oversized = {
      ...item,
      audit: item.audit && { ...item.audit, after: { note: SECRET.repeat(2_000) } },
    };
    expect((await server.upload(oversized))[0]).toMatchObject({ status: 'accepted' });
    expect(server.campaign.rows.size).toBe(0);
    expect(server.signals.map((entry) => entry.kind)).toEqual(['deadLettered']);
  });

  test('diagnostics carry identifiers and codes, never payload content', async () => {
    const server = harness();
    server.campaign.down = true;
    const item = mutation();
    await server.upload(item);
    server.campaign.down = false;
    await server.recorder.retryPending();
    const text = JSON.stringify(server.signals);
    expect(text).not.toContain(SECRET);
    expect(text).toContain(item.mutationId);
    expect(server.signals.map((entry) => entry.kind)).toEqual(['degraded', 'repaired']);
  });

  test('record-only override records accepted outcomes and swallows recorder faults', async () => {
    const recorded: unknown[] = [];
    const participant = recordOnlyMutationAuditParticipant({
      record: async (event) => void recorded.push(event),
    });
    const audit = mutation().audit as Omit<AuditEvent, 'id'>;
    const withActor = { ...audit, actor: ACTOR };
    await participant.recordMutationOutcome({
      mutationId: crypto.randomUUID(),
      outcome: { mutationId: 'x', status: 'error', code: 'c', retryable: false },
      audit: withActor,
    });
    await participant.recordMutationOutcome({
      mutationId: crypto.randomUUID(),
      outcome: { mutationId: 'x', status: 'accepted', acceptedVersion: 2, serverCursor: 'c' },
      audit: withActor,
    });
    expect(recorded).toEqual([withActor]);
    await recordOnlyMutationAuditParticipant({
      record: async () => {
        throw new Error('down');
      },
    }).recordMutationOutcome({
      mutationId: crypto.randomUUID(),
      outcome: { mutationId: 'x', status: 'accepted', acceptedVersion: 2, serverCursor: 'c' },
      audit: withActor,
    });
  });
});

describe('identity membership audit through the durable recorder (feature 01 task 12)', () => {
  const OWNER = '0198f702-4be0-7000-8000-0000000000e1';
  const PLAYER = '0198f702-4be0-7000-8000-0000000000e2';
  const at = new Date('2026-10-25T10:00:00Z');
  const records = new Map<string, MembershipRecord>([
    [
      OWNER,
      {
        campaignId: CAMPAIGN,
        userId: OWNER,
        username: 'o',
        role: 'owner',
        version: 1,
        updatedAt: at,
        removedAt: null,
      },
    ],
    [
      PLAYER,
      {
        campaignId: CAMPAIGN,
        userId: PLAYER,
        username: 'p',
        role: 'player',
        version: 1,
        updatedAt: at,
        removedAt: null,
      },
    ],
  ]);
  const store = {
    find: async (_campaignId: string, userId: string) => records.get(userId),
    remove: async ({ targetUserId }: { targetUserId: string }) => {
      const current = records.get(targetUserId) as MembershipRecord;
      const changed = { ...current, removedAt: at, version: current.version + 1 };
      records.set(targetUserId, changed);
      return { ok: true as const, value: changed };
    },
    changeRole: async ({ targetUserId, role }: { targetUserId: string; role: 'player' | 'gm' }) => {
      const current = records.get(targetUserId) as MembershipRecord;
      const changed = { ...current, role, version: current.version + 1 };
      records.set(targetUserId, changed);
      return { ok: true as const, value: changed };
    },
  } as unknown as MembershipStore;
  const quiet = { integrationDegraded: () => undefined };
  const noRevocation = { publish: async () => undefined };

  test('origin ID is a stable function of campaign, user, version, and action', () => {
    const base = {
      campaignId: CAMPAIGN,
      userId: PLAYER,
      membershipVersion: 2,
      action: 'membership.removed',
    };
    expect(membershipAuditOriginId(base)).toBe(membershipAuditOriginId({ ...base }));
    expect(membershipAuditOriginId(base)).toMatch(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
    for (const other of [
      { ...base, membershipVersion: 3 },
      { ...base, userId: OWNER },
      { ...base, action: 'membership.role_changed' },
      { ...base, campaignId: USER },
    ]) {
      expect(membershipAuditOriginId(other)).not.toBe(membershipAuditOriginId(base));
    }
  });

  test('audit store outage after commit: outbox retry produces exactly one event', async () => {
    const server = harness();
    records.set(PLAYER, {
      ...(records.get(PLAYER) as MembershipRecord),
      version: 1,
      removedAt: null,
    });
    const service = new MembershipService(
      store,
      membershipAuditRecorderFor(server.recorder),
      noRevocation,
      quiet,
    );
    server.campaign.down = true;
    expect((await service.remove(OWNER, CAMPAIGN, PLAYER)).ok).toBe(true);
    // Membership stands, nothing stored yet, and the event waits in the repair outbox.
    expect((await service.resolve(PLAYER, CAMPAIGN)).ok).toBe(false);
    expect(server.campaign.rows.size).toBe(0);
    expect(await server.recorder.backlog()).toMatchObject({ outboxPending: 1 });
    expect(server.signals.map((entry) => entry.kind)).toContain('degraded');

    server.campaign.down = false;
    expect((await server.recorder.retryPending()).repaired).toBe(1);
    expect(server.campaign.rows.size).toBe(1);
    expect([...server.campaign.rows.values()][0]?.event).toMatchObject({
      action: 'membership.removed',
      targetId: PLAYER,
      after: { version: 2, removed: true },
    });
    expect(
      server.campaign.rows.has(
        membershipAuditOriginId({
          campaignId: CAMPAIGN,
          userId: PLAYER,
          membershipVersion: 2,
          action: 'membership.removed',
        }),
      ),
    ).toBe(true);
    expect(await server.recorder.backlog()).toMatchObject({ outboxPending: 0 });
  });

  test('replaying the degraded post-commit call stores one event; a new version stores another', async () => {
    const server = harness();
    const recorder = membershipAuditRecorderFor(server.recorder);
    const event = (version: number, action: string, when: string): Omit<AuditEvent, 'id'> => ({
      campaignId: CAMPAIGN,
      actor: { userId: OWNER, campaignId: CAMPAIGN, role: 'owner' },
      action,
      targetType: 'campaign_membership',
      targetId: PLAYER,
      after: { role: 'player', version, removed: action === 'membership.removed' },
      at: when,
      private: false,
    });
    server.campaign.loseAckNext = 1;
    await recorder.record(event(2, 'membership.removed', '2026-10-25T10:00:00.000Z'));
    // Replay from the integrationDegraded key (same campaign, user, version, action), later clock.
    await recorder.record(event(2, 'membership.removed', '2026-10-25T10:05:00.000Z'));
    await recorder.record(event(2, 'membership.removed', '2026-10-25T10:06:00.000Z'));
    await server.recorder.retryPending();
    expect(server.campaign.rows.size).toBe(1);

    await recorder.record(event(1, 'membership.created', '2026-10-25T10:07:00.000Z'));
    await recorder.record(event(3, 'membership.role_changed', '2026-10-25T10:08:00.000Z'));
    expect([...server.campaign.rows.values()].map((row) => row.event.action).sort()).toEqual([
      'membership.created',
      'membership.removed',
      'membership.role_changed',
    ]);
  });

  test('invitation acceptance audit is idempotent per membership version', async () => {
    const server = harness();
    const accepted = {
      user: { id: PLAYER, username: 'p' },
      campaignId: CAMPAIGN,
      role: 'player' as const,
      version: 1,
      updatedAt: at.toISOString(),
    };
    const invitations = new InvitationService(
      {
        accept: async () => ({ ok: true as const, value: accepted }),
      } as unknown as InvitationStore,
      membershipAuditRecorderFor(server.recorder),
      quiet,
    );
    const token = 'x'.repeat(43);
    await invitations.accept(PLAYER, token);
    await invitations.accept(PLAYER, token);
    expect(server.campaign.rows.size).toBe(1);
  });

  test('role change records once per committed version and non-membership events keep generated origins', async () => {
    const server = harness();
    records.set(PLAYER, {
      ...(records.get(PLAYER) as MembershipRecord),
      version: 1,
      role: 'player',
      removedAt: null,
    });
    const service = new MembershipService(
      store,
      membershipAuditRecorderFor(server.recorder),
      noRevocation,
      quiet,
    );
    expect((await service.changeRole(OWNER, CAMPAIGN, PLAYER, 'gm')).ok).toBe(true);
    expect((await service.changeRole(OWNER, CAMPAIGN, PLAYER, 'player')).ok).toBe(true);
    expect(server.campaign.rows.size).toBe(2);
    const generic = membershipAuditRecorderFor(server.recorder);
    const other = { ...mutation().audit, actor: ACTOR } as Omit<AuditEvent, 'id'>;
    await generic.record(other);
    await generic.record(other);
    expect(server.campaign.rows.size).toBe(4);
  });
});

describe('audit target visibility from feature 04 declarations (feature 06 task 01)', () => {
  const readers = {
    owner: ['read'],
    gm: ['read'],
    assistant_gm: ['read'],
    player: ['read'],
    observer: [],
  } satisfies ResourcePolicy['roleCapabilities'];
  const serverOnly = { kind: 'server_only' } as const;
  function policies(): ResourcePolicyRegistry {
    const registry = registerResourcePolicies(new ResourcePolicyRegistry());
    registry.register(AUTHOR_PRIVATE_NOTE_FIXTURE);
    registry.register({
      resourceClass: 'fixture.handout',
      capabilities: ['read', 'reveal'],
      roleCapabilities: { ...readers, owner: ['read', 'reveal'], gm: ['read', 'reveal'] },
      defaultVisibility: { mode: 'everyone' },
      sync: serverOnly,
    });
    registry.register({
      resourceClass: 'fixture.prep',
      capabilities: ['read'],
      roleCapabilities: readers,
      defaultVisibility: 'explicit',
      sync: serverOnly,
    });
    registry.register({
      resourceClass: 'fixture.rulebook',
      capabilities: ['read', 'update'],
      roleCapabilities: { ...readers, owner: ['read', 'update'] },
      defaultVisibility: { mode: 'gm_only' },
      ownership: { field: 'authorUserId', capabilities: ['update'], exemptRoles: ['owner'] },
      sync: serverOnly,
    });
    return registry;
  }

  test('only a declaration that fixes every record answers; everything else fails closed', () => {
    const targets = auditTargetDeclarationsFor(policies());
    // Campaign-wide, no reveal: every campaign row is visible to its readers.
    expect(targets.snapshotFor('campaign')).toEqual({ visibility: { mode: 'everyone' } });
    // Static default with ownership on update only: read visibility is still the default.
    expect(targets.snapshotFor('fixture.rulebook')).toEqual({ visibility: { mode: 'gm_only' } });
    // Server-only GM-reader class with a static default and no reveal.
    expect(targets.snapshotFor('campaign_membership')).toEqual({ visibility: { mode: 'gm_only' } });
    // Undeclared, reveal-capable (a record may differ from the default), explicit default,
    // and author-private (needs the author) need facts from the caller.
    for (const targetType of [
      'fixture.handout',
      'fixture.prep',
      AUTHOR_PRIVATE_NOTE_FIXTURE.resourceClass,
      // Feature 16 task 03: reveal-capable entities and author-private notes keep GM-only.
      'campaign_entity',
      'personal_note',
    ]) {
      expect({ targetType, snapshot: targets.snapshotFor(targetType) }).toEqual({
        targetType,
        snapshot: undefined,
      });
    }
  });

  test('the runtime recorder snapshots campaign events from the declaration and keeps facts', async () => {
    const campaign = new FakeStore();
    const recorder = new DurableAuditRecorder({
      campaign,
      private: new FakeStore(),
      account: new FakeAccountStore(),
      outbox: new FakeOutbox(),
      registry: new AuditRendererRegistry(),
      diagnostics: {
        degraded: () => undefined,
        deadLettered: () => undefined,
        repaired: () => undefined,
      },
      targets: auditTargetDeclarationsFor(registerResourcePolicies(new ResourcePolicyRegistry())),
      options: { baseDelayMs: 0, attemptTimeoutMs: 50 },
    });
    const base = { ...mutation().audit, actor: ACTOR } as Omit<AuditEvent, 'id'>;
    const record = async (
      event: Omit<AuditEvent, 'id'>,
      targetVisibility?: TargetVisibilitySnapshot,
    ) => {
      const originMutationId = crypto.randomUUID();
      expect(
        await recorder.recordCampaign({
          event,
          originMutationId,
          ...(targetVisibility === undefined ? {} : { targetVisibility }),
        }),
      ).toBe('recorded');
      return campaign.rows.get(originMutationId)?.targetVisibility;
    };
    expect(await record({ ...base, action: 'campaign.created', targetType: 'campaign' })).toEqual({
      visibility: { mode: 'everyone' },
    });
    expect(
      await record({ ...base, action: 'membership.created', targetType: 'campaign_membership' }),
    ).toEqual({ visibility: { mode: 'gm_only' } });
    // Feature 16: undescribed entity and personal-note events fall back to GM-only.
    for (const targetType of ['campaign_entity', 'personal_note']) {
      expect(await record({ ...base, action: 'campaign.renamed', targetType })).toEqual({
        visibility: { mode: 'gm_only' },
      });
    }
    // Feature 04 visibility events pass their own facts (GM-only plus author); never widened.
    const facts: TargetVisibilitySnapshot = { visibility: { mode: 'gm_only' }, authorUserId: USER };
    expect(
      await record({ ...base, action: 'visibility.revealed', targetType: 'campaign' }, facts),
    ).toEqual(facts);
  });
});

describe('in-transaction mutation audit adapter (feature 06 task 02)', () => {
  test('holds only what the transaction kept; anything else asks for after-commit recording', async () => {
    const transaction: AuditSqlExecutor = {
      execute: async () => undefined,
      transaction: async (work) => work(transaction),
    };
    const audit = { ...mutation().audit, actor: ACTOR } as Omit<AuditEvent, 'id'>;
    const mutationId = crypto.randomUUID();
    const seen: unknown[] = [];
    const held: boolean[] = [];
    for (const outcome of [
      'recorded',
      'duplicate',
      'deferred',
      'dead_lettered',
      new Error(`recorder defect ${SECRET}`),
    ] as const) {
      const participant = mutationAuditParticipantFor({
        recordMutationOutcome: async () => 'skipped',
        recordWithin: async (executor, submission) => {
          seen.push([executor, submission]);
          if (outcome instanceof Error) throw outcome;
          return outcome;
        },
      });
      held.push(
        (await participant.recordAcceptedWithin?.(transaction, { mutationId, audit })) === true,
      );
    }
    // `dead_lettered` inside a transaction means nothing pending is held there.
    expect(held).toEqual([true, true, true, false, false]);
    expect(seen[0]).toEqual([transaction, { event: audit, originMutationId: mutationId }]);

    // Not a SQL executor (for example an in-memory repository): never handed to the recorder.
    let called = false;
    const strict = mutationAuditParticipantFor({
      recordMutationOutcome: async () => 'skipped',
      recordWithin: async () => {
        called = true;
        return 'recorded';
      },
    });
    expect(await strict.recordAcceptedWithin?.({}, { mutationId, audit })).toBe(false);
    expect(await strict.recordAcceptedWithin?.(undefined, { mutationId, audit })).toBe(false);
    expect(called).toBe(false);
  });
});
