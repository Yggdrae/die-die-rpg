import { describe, expect, test } from 'bun:test';
import type { AuditEvent } from '@rpg/contracts';
import { Type } from '@sinclair/typebox';
import {
  type AuditAppender,
  type AuditAppendResult,
  type AuditEnvelope,
  type AuditTargetDeclarations,
  deriveAuditEventId,
  routeCampaignEvent,
  type TargetVisibilitySnapshot,
} from './model.ts';
import {
  type AuditDiagnostics,
  type AuditFailureSignal,
  type AuditParkInput,
  type AuditRepairEntry,
  type AuditRepairOutbox,
  DurableAuditRecorder,
} from './recorder.ts';
import { AuditRendererRegistry } from './renderers.ts';

const SECRET = 'hidden-gm-note';
const campaignId = '0198f702-4be0-7000-8000-0000000000c1';
const userId = '0198f702-4be0-7000-8000-0000000000a1';

function event(overrides: Partial<Omit<AuditEvent, 'id'>> = {}): Omit<AuditEvent, 'id'> {
  return {
    campaignId,
    actor: { userId, campaignId, role: 'gm' },
    action: 'resource.changed',
    targetType: 'character_resource',
    targetId: '0198f702-4be0-7000-8000-0000000000b1',
    before: { value: 6, note: SECRET },
    after: { value: 2, note: SECRET },
    at: '2026-10-24T12:00:00.000Z',
    private: false,
    ...overrides,
  };
}

class FakeStore<T extends AuditEnvelope> implements AuditAppender<T> {
  readonly rows = new Map<string, T>();
  failNext = 0;
  /** Store the row, then fail: the acknowledgement is lost. */
  loseAckNext = 0;
  hang = false;

  async append(envelope: T): Promise<AuditAppendResult> {
    if (this.hang) return new Promise(() => undefined);
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error(`store down ${SECRET}`);
    }
    const existing = this.rows.get(envelope.originMutationId);
    const result: AuditAppendResult =
      existing === undefined
        ? { status: 'inserted', eventId: envelope.eventId, sequence: this.rows.size + 1 }
        : { status: 'duplicate', eventId: existing.eventId, sequence: 1 };
    if (existing === undefined) this.rows.set(envelope.originMutationId, envelope);
    if (this.loseAckNext > 0) {
      this.loseAckNext -= 1;
      throw new Error('acknowledgement lost');
    }
    return result;
  }

  appendWithin(_executor: unknown, envelope: T): Promise<AuditAppendResult> {
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
    if (this.down) throw new Error('outbox down');
    const values = [...this.entries.values()].filter((entry) => !entry.resolved);
    return {
      pending: values.filter((entry) => entry.state === 'pending').length,
      dead: values.filter((entry) => entry.state === 'dead').length,
    };
  }
}

function harness({
  targets,
  ...options
}: {
  maxAttempts?: number;
  memoryQueueLimit?: number;
  targets?: AuditTargetDeclarations;
} = {}) {
  const campaign = new FakeStore<Extract<AuditEnvelope, { store: 'campaign' | 'private' }>>();
  const privateStore = new FakeStore<Extract<AuditEnvelope, { store: 'campaign' | 'private' }>>();
  const account = new FakeStore<Extract<AuditEnvelope, { store: 'account' }>>();
  const outbox = new FakeOutbox();
  const registry = new AuditRendererRegistry();
  const signals: { kind: string; signal: unknown }[] = [];
  const diagnostics: AuditDiagnostics = {
    degraded: (signal) => signals.push({ kind: 'degraded', signal }),
    deadLettered: (signal) => signals.push({ kind: 'deadLettered', signal }),
    repaired: (signal) => signals.push({ kind: 'repaired', signal }),
  };
  let now = new Date('2026-10-24T12:00:00.000Z');
  const recorder = new DurableAuditRecorder({
    campaign,
    private: privateStore,
    account,
    outbox,
    registry,
    diagnostics,
    ...(targets === undefined ? {} : { targets }),
    options: {
      baseDelayMs: 1_000,
      attemptTimeoutMs: 50,
      now: () => now,
      ...options,
    },
  });
  return {
    recorder,
    campaign,
    privateStore,
    account,
    outbox,
    registry,
    signals,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
  };
}

describe('routing and identity', () => {
  test('private alone selects exactly one physical store', async () => {
    const h = harness();
    expect(routeCampaignEvent({ private: false })).toBe('campaign');
    expect(routeCampaignEvent({ private: true })).toBe('private');

    await h.recorder.record(event({ private: false }));
    await h.recorder.record(event({ private: true }));

    expect(h.campaign.rows.size).toBe(1);
    expect(h.privateStore.rows.size).toBe(1);
    expect([...h.campaign.rows.values()][0]?.event.private).toBe(false);
    expect([...h.privateStore.rows.values()][0]?.event.private).toBe(true);
  });

  test('event ID is derived once from the origin mutation ID', async () => {
    const h = harness();
    const origin = crypto.randomUUID();
    const id = deriveAuditEventId(origin);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(deriveAuditEventId(origin)).toBe(id);
    expect(deriveAuditEventId(crypto.randomUUID())).not.toBe(id);

    expect(await h.recorder.recordCampaign({ event: event(), originMutationId: origin })).toBe(
      'recorded',
    );
    expect(await h.recorder.recordCampaign({ event: event(), originMutationId: origin })).toBe(
      'duplicate',
    );
    expect(h.campaign.rows.get(origin)?.eventId).toBe(id);
    expect(h.campaign.rows.get(origin)?.event.id).toBe(id);
  });

  test('undeclared target visibility fails closed to GM-only; declarations override', async () => {
    const h = harness();
    h.registry.register({
      action: 'campaign.renamed',
      version: 3,
      targetVisibility: { mode: 'everyone' },
      render: () => ({ text: 'Campaign renamed.' }),
    });
    await h.recorder.record(event());
    await h.recorder.record(event({ action: 'campaign.renamed', targetType: 'campaign' }));
    const [undeclared, declared] = [...h.campaign.rows.values()];
    expect(undeclared?.targetVisibility).toEqual({ visibility: { mode: 'gm_only' } });
    expect(undeclared?.rendererVersion).toBe(0);
    expect(declared?.targetVisibility).toEqual({ visibility: { mode: 'everyone' } });
    expect(declared?.rendererVersion).toBe(3);
  });

  test('target-class declarations fill an undescribed snapshot; caller and action win; faults fail closed', async () => {
    const asked: string[] = [];
    const h = harness({
      targets: {
        snapshotFor: (targetType) => {
          asked.push(targetType);
          if (targetType === 'campaign') return { visibility: { mode: 'everyone' } };
          if (targetType === 'broken') throw new Error(SECRET);
          if (targetType === 'malformed') {
            return { visibility: { mode: 'players' } } as unknown as TargetVisibilitySnapshot;
          }
          return undefined;
        },
      },
    });
    h.registry.register({
      action: 'campaign.archived',
      version: 1,
      targetVisibility: { mode: 'gm_only' },
      render: () => ({ text: 'Campaign archived.' }),
    });
    const record = (targetType: string, extra: { action?: string } = {}) =>
      h.recorder.recordCampaign({
        originMutationId: crypto.randomUUID(),
        event: event({ targetType, ...extra }),
      });
    const snapshotOf = async (outcome: Promise<unknown>) => {
      expect(await outcome).toBe('recorded');
      return [...h.campaign.rows.values()].at(-1)?.targetVisibility;
    };
    const everyone: TargetVisibilitySnapshot = { visibility: { mode: 'everyone' } };
    const gmOnly: TargetVisibilitySnapshot = { visibility: { mode: 'gm_only' } };

    // Declared static class: the declaration's visibility.
    expect(await snapshotOf(record('campaign'))).toEqual(everyone);
    // Undeclared, throwing, or malformed lookups stay GM-only and never drop the event.
    expect(await snapshotOf(record('campaign_membership'))).toEqual(gmOnly);
    expect(await snapshotOf(record('broken'))).toEqual(gmOnly);
    expect(await snapshotOf(record('malformed'))).toEqual(gmOnly);
    // The action's own declaration and the caller's facts take precedence; no lookup happens.
    asked.length = 0;
    expect(await snapshotOf(record('campaign', { action: 'campaign.archived' }))).toEqual(gmOnly);
    const facts: TargetVisibilitySnapshot = {
      visibility: { mode: 'gm_only' },
      authorUserId: userId,
    };
    expect(
      await snapshotOf(
        h.recorder.recordCampaign({
          event: event({ targetType: 'campaign' }),
          targetVisibility: facts,
        }),
      ),
    ).toEqual(facts);
    expect(asked).toEqual([]);
    expect(h.signals).toEqual([]);
  });

  test('account events go only to the account store', async () => {
    const h = harness();
    const tokenId = crypto.randomUUID();
    const outcome = await h.recorder.recordAccount({
      originMutationId: tokenId,
      event: {
        subjectUserId: userId,
        actor: { kind: 'operator', reference: 'host:desk-1' },
        action: 'recovery.issued',
        targetType: 'recovery_token',
        targetId: tokenId,
        after: { expiresAt: '2026-10-24T12:30:00.000Z' },
        at: '2026-10-24T12:00:00.000Z',
      },
    });
    expect(outcome).toBe('recorded');
    expect(h.account.rows.size).toBe(1);
    expect(h.campaign.rows.size + h.privateStore.rows.size).toBe(0);
  });
});

describe('non-blocking failure handling', () => {
  test('store outage defers to the outbox and one retry stores exactly one event', async () => {
    const h = harness();
    h.campaign.failNext = 1;
    const origin = crypto.randomUUID();

    expect(await h.recorder.recordCampaign({ event: event(), originMutationId: origin })).toBe(
      'deferred',
    );
    expect(h.campaign.rows.size).toBe(0);
    expect(await h.recorder.backlog()).toEqual({
      memoryPending: 0,
      outboxPending: 1,
      outboxDead: 0,
    });

    expect((await h.recorder.retryPending()).repaired).toBe(0); // not due yet
    h.advance(1_000);
    expect(await h.recorder.retryPending()).toEqual({
      repaired: 1,
      deferred: 0,
      deadLettered: 0,
      outboxReadable: true,
    });
    expect(h.campaign.rows.size).toBe(1);
    expect((await h.recorder.retryPending()).repaired).toBe(0);
    expect(h.signals.map((entry) => entry.kind)).toEqual(['degraded', 'repaired']);
    expect(h.signals[0]?.signal).toMatchObject({
      originMutationId: origin,
      store: 'campaign',
      code: 'store_unavailable',
      attempt: 1,
      parkedIn: 'outbox',
    });
  });

  test('lost acknowledgement retries into the existing single event', async () => {
    const h = harness();
    h.campaign.loseAckNext = 1;
    expect(await h.recorder.recordCampaign({ event: event() })).toBe('deferred');
    expect(h.campaign.rows.size).toBe(1);
    h.advance(1_000);
    expect((await h.recorder.retryPending()).repaired).toBe(1);
    expect(h.campaign.rows.size).toBe(1);
    expect((await h.recorder.backlog()).outboxPending).toBe(0);
  });

  test('store and outbox both down: record resolves, waits in memory, then repairs', async () => {
    const h = harness();
    h.campaign.failNext = 2;
    h.outbox.down = true;

    await expect(h.recorder.record(event())).resolves.toBeUndefined();
    expect(await h.recorder.backlog()).toEqual({ memoryPending: 1 });

    h.advance(1_000);
    const second = await h.recorder.retryPending();
    expect(second).toMatchObject({ repaired: 0, deferred: 1, outboxReadable: false });

    h.outbox.down = false;
    h.advance(10_000);
    expect((await h.recorder.retryPending()).repaired).toBe(1);
    expect(h.campaign.rows.size).toBe(1);
    expect((await h.recorder.backlog()).memoryPending).toBe(0);
  });

  test('a hung store times out instead of stalling the caller', async () => {
    const h = harness();
    h.campaign.hang = true;
    const started = performance.now();
    expect(await h.recorder.recordCampaign({ event: event() })).toBe('deferred');
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(h.signals[0]?.signal).toMatchObject({ code: 'store_timeout', parkedIn: 'outbox' });
  });

  test('retry exhaustion dead-letters with an operator signal', async () => {
    const h = harness({ maxAttempts: 2 });
    h.campaign.failNext = 5;
    await h.recorder.record(event());
    h.advance(60_000);
    expect((await h.recorder.retryPending()).deadLettered).toBe(1);
    expect(await h.recorder.backlog()).toMatchObject({ outboxPending: 0, outboxDead: 1 });
    expect(h.signals.at(-1)).toMatchObject({
      kind: 'deadLettered',
      signal: { code: 'retry_exhausted', attempt: 2, parkedIn: 'outbox' },
    });
  });

  test('invalid events are dead-lettered, never stored, never thrown', async () => {
    const h = harness();
    const outcomes = [
      await h.recorder.recordCampaign({ event: event({ targetId: 'not-a-uuid' }) }),
      await h.recorder.recordCampaign({ event: event(), originMutationId: 'bad-origin' }),
      await h.recorder.recordCampaign({
        event: event({ after: { blob: 'x'.repeat(20_000) } }),
      }),
    ];
    expect(outcomes).toEqual(['dead_lettered', 'dead_lettered', 'dead_lettered']);
    expect(h.campaign.rows.size).toBe(0);
    expect((await h.recorder.backlog()).outboxDead).toBe(3);
    expect(h.signals.every((entry) => entry.kind === 'deadLettered')).toBe(true);
  });

  test('payload schema violations are dead-lettered', async () => {
    const h = harness();
    h.registry.register({
      action: 'resource.changed',
      version: 1,
      payload: Type.Object({ value: Type.Integer() }),
      render: () => ({ text: 'changed' }),
    });
    expect(await h.recorder.recordCampaign({ event: event({ after: { value: 'two' } }) })).toBe(
      'dead_lettered',
    );
  });

  test('signals never carry payload content', async () => {
    const h = harness({ maxAttempts: 2 });
    h.campaign.failNext = 10;
    h.outbox.down = true;
    await h.recorder.record(event());
    h.advance(60_000);
    await h.recorder.retryPending();
    await h.recorder.recordCampaign({ event: event({ targetId: SECRET }) });
    expect(h.signals.length).toBeGreaterThan(1);
    const serialized = JSON.stringify(h.signals);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain('"value"');
    for (const { signal } of h.signals) {
      expect(Object.keys(signal as AuditFailureSignal).sort()).toEqual(
        expect.arrayContaining(['attempt', 'eventId', 'originMutationId', 'store']),
      );
    }
  });

  test('throwing diagnostics cannot fail the caller', async () => {
    const h = harness();
    const recorder = new DurableAuditRecorder({
      campaign: h.campaign,
      private: h.privateStore,
      account: h.account,
      outbox: h.outbox,
      registry: h.registry,
      diagnostics: {
        degraded: () => {
          throw new Error('logger down');
        },
        deadLettered: () => {
          throw new Error('logger down');
        },
        repaired: () => {
          throw new Error('logger down');
        },
      },
    });
    h.campaign.failNext = 1;
    await expect(recorder.record(event())).resolves.toBeUndefined();
  });

  test('bounded memory queue dead-letters overflow instead of growing', async () => {
    const h = harness({ memoryQueueLimit: 1 });
    h.campaign.failNext = 10;
    h.outbox.down = true;
    expect(await h.recorder.recordCampaign({ event: event() })).toBe('deferred');
    expect(await h.recorder.recordCampaign({ event: event() })).toBe('dead_lettered');
    expect(h.signals.at(-1)).toMatchObject({
      kind: 'deadLettered',
      signal: { code: 'memory_queue_full', parkedIn: 'none' },
    });
  });
});

describe('mutation envelope', () => {
  test('only an accepted mutation becomes history; resubmission stays single', async () => {
    const h = harness();
    const mutationId = crypto.randomUUID();
    for (const status of ['conflict', 'error'] as const) {
      expect(
        await h.recorder.recordMutationOutcome({
          mutationId,
          outcome: { status },
          audit: event(),
        }),
      ).toBe('skipped');
    }
    expect(h.campaign.rows.size).toBe(0);

    const accepted = { mutationId, outcome: { status: 'accepted' as const }, audit: event() };
    expect(await h.recorder.recordMutationOutcome(accepted)).toBe('recorded');
    expect(await h.recorder.recordMutationOutcome(accepted)).toBe('duplicate');
    expect(h.campaign.rows.size).toBe(1);
    expect(h.campaign.rows.get(mutationId)?.eventId).toBe(deriveAuditEventId(mutationId));
  });

  test('in-transaction failure with no outbox is a signalled gap, not a memory replay', async () => {
    const h = harness();
    h.campaign.failNext = 1;
    h.outbox.down = true;
    const outcome = await h.recorder.recordWithin(
      {
        execute: async () => [],
        transaction: (work) =>
          work({ execute: async () => [], transaction: () => Promise.reject() }),
      },
      { event: event(), originMutationId: crypto.randomUUID() },
    );
    expect(outcome).toBe('dead_lettered');
    expect((await h.recorder.backlog()).memoryPending).toBe(0);
    expect(h.signals.at(-1)).toMatchObject({ kind: 'deadLettered', signal: { parkedIn: 'none' } });
  });
});
