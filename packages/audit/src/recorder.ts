import type { AuditEvent, AuditRecorder } from '@rpg/contracts';
import {
  type AccountAuditEnvelope,
  type AccountAuditEvent,
  type AuditAppender,
  type AuditAppendResult,
  type AuditEnvelope,
  type AuditSqlExecutor,
  type AuditStoreName,
  type AuditTargetDeclarations,
  type CampaignAuditEnvelope,
  deriveAuditEventId,
  FAIL_CLOSED_VISIBILITY,
  isAuditId,
  isValidAccountEvent,
  isValidCampaignEvent,
  isValidVisibilitySnapshot,
  routeCampaignEvent,
  type TargetVisibilitySnapshot,
} from './model.ts';
import type { AuditRendererRegistry } from './renderers.ts';

export type AuditFailureCode =
  | 'invalid_event'
  | 'store_unavailable'
  | 'store_timeout'
  | 'retry_exhausted'
  | 'memory_queue_full';

/**
 * Safe operator signal. Identifiers and codes only: never actor, before/after, or any other
 * payload value (feature 06 TechSpec, Failure Handling and Observability).
 */
export interface AuditFailureSignal {
  readonly eventId: string;
  readonly originMutationId: string;
  readonly store: AuditStoreName;
  readonly code: AuditFailureCode;
  readonly attempt: number;
  /** Where the event now waits: durable outbox, process memory, or nowhere (a gap). */
  readonly parkedIn: 'outbox' | 'memory' | 'none';
}

export interface AuditDiagnostics {
  /** Append failed; a retry is scheduled. */
  degraded(signal: AuditFailureSignal): void;
  /** No further automatic retry. Raises an operator alert; may be an audit gap. */
  deadLettered(signal: AuditFailureSignal): void;
  /** A previously failed event is now stored exactly once. */
  repaired(signal: Omit<AuditFailureSignal, 'code' | 'parkedIn'>): void;
}

export interface AuditRepairEntry {
  readonly envelope: AuditEnvelope;
  readonly attemptCount: number;
}

export interface AuditParkInput {
  readonly envelope: AuditEnvelope | InvalidAuditSubmission;
  readonly state: 'pending' | 'dead';
  readonly code: AuditFailureCode;
  readonly attemptCount: number;
  readonly nextAttemptAt: Date;
}

/** An event rejected by validation, kept for repair. `store` is where it would have gone. */
export interface InvalidAuditSubmission {
  readonly store: AuditStoreName;
  readonly eventId: string;
  readonly originMutationId: string;
  readonly invalid: unknown;
}

/** Restricted repair/dead-letter state. */
export interface AuditRepairOutbox {
  park(input: AuditParkInput): Promise<void>;
  parkWithin(executor: AuditSqlExecutor, input: AuditParkInput): Promise<void>;
  due(now: Date, limit: number): Promise<readonly AuditRepairEntry[]>;
  resolve(eventId: string): Promise<void>;
  backlog(): Promise<{ readonly pending: number; readonly dead: number }>;
}

export type AuditRecordOutcome = 'recorded' | 'duplicate' | 'deferred' | 'dead_lettered';

export interface AuditRetryReport {
  readonly repaired: number;
  readonly deferred: number;
  readonly deadLettered: number;
  readonly outboxReadable: boolean;
}

export interface DurableAuditRecorderOptions {
  /** Attempts before an event is dead-lettered. Default 8. */
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  /** Bound on each append so a hung store never stalls the caller. Default 3000. */
  readonly attemptTimeoutMs?: number;
  /** In-process fallback when the outbox itself is unreachable. Default 1000. */
  readonly memoryQueueLimit?: number;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

export interface DurableAuditRecorderDependencies {
  readonly campaign: AuditAppender<CampaignAuditEnvelope>;
  readonly private: AuditAppender<CampaignAuditEnvelope>;
  readonly account: AuditAppender<AccountAuditEnvelope>;
  readonly outbox: AuditRepairOutbox;
  readonly registry: AuditRendererRegistry;
  readonly diagnostics: AuditDiagnostics;
  /** Feature 04 target-class declarations; absent means every undescribed target is GM-only. */
  readonly targets?: AuditTargetDeclarations;
  readonly options?: DurableAuditRecorderOptions;
}

export interface CampaignAuditSubmission {
  readonly event: Omit<AuditEvent, 'id'>;
  /** Feature 03 mutation ID when the event travels in a mutation envelope. */
  readonly originMutationId?: string;
  readonly targetVisibility?: TargetVisibilitySnapshot;
}

export interface AccountAuditSubmission {
  readonly event: AccountAuditEvent;
  readonly originMutationId?: string;
}

interface MemoryEntry {
  readonly envelope: AuditEnvelope;
  attemptCount: number;
  nextAttemptAt: number;
}

class AuditAttemptTimeout extends Error {}

/**
 * Feature 06 `AuditRecorder` adapter. `record()` and every other entry point resolve and
 * never throw: an audit fault degrades to the repair outbox (durable) or, if that is also
 * unreachable, to a bounded in-process retry queue, and is always signalled through
 * `AuditDiagnostics` without payload content (FR-009).
 *
 * The stable event ID is derived from the origin mutation ID before the first attempt, and
 * each store is idempotent by origin mutation ID, so a retry or lost acknowledgement stores
 * exactly one event.
 */
export class DurableAuditRecorder implements AuditRecorder {
  readonly #deps: DurableAuditRecorderDependencies;
  readonly #maxAttempts: number;
  readonly #baseDelayMs: number;
  readonly #maxDelayMs: number;
  readonly #attemptTimeoutMs: number;
  readonly #memoryQueueLimit: number;
  readonly #now: () => Date;
  readonly #newId: () => string;
  readonly #memory = new Map<string, MemoryEntry>();
  #retrying: Promise<AuditRetryReport> | undefined;

  constructor(deps: DurableAuditRecorderDependencies) {
    this.#deps = deps;
    const options = deps.options ?? {};
    this.#maxAttempts = options.maxAttempts ?? 8;
    this.#baseDelayMs = options.baseDelayMs ?? 1_000;
    this.#maxDelayMs = options.maxDelayMs ?? 5 * 60_000;
    this.#attemptTimeoutMs = options.attemptTimeoutMs ?? 3_000;
    this.#memoryQueueLimit = options.memoryQueueLimit ?? 1_000;
    this.#now = options.now ?? (() => new Date());
    this.#newId = options.newId ?? (() => crypto.randomUUID());
  }

  /** Frozen contract entry point: post-commit, non-blocking, never throws. */
  async record(event: Omit<AuditEvent, 'id'>): Promise<void> {
    await this.recordCampaign({ event });
  }

  async recordCampaign(submission: CampaignAuditSubmission): Promise<AuditRecordOutcome> {
    const prepared = this.#prepareCampaign(submission);
    if ('invalid' in prepared) return this.#rejectInvalid(prepared);
    return this.#deliver(prepared);
  }

  async recordAccount(submission: AccountAuditSubmission): Promise<AuditRecordOutcome> {
    const prepared = this.#prepareAccount(submission);
    if ('invalid' in prepared) return this.#rejectInvalid(prepared);
    return this.#deliver(prepared);
  }

  /**
   * Feature 03 envelope hook for an uploaded mutation. Only an accepted outcome becomes
   * history; a conflict or rejection stores nothing. The mutation ID is the origin ID, so
   * a resubmission after a lost acknowledgement resolves to the same single event.
   */
  async recordMutationOutcome(input: {
    readonly mutationId: string;
    readonly outcome: { readonly status: 'accepted' | 'conflict' | 'error' };
    readonly audit: Omit<AuditEvent, 'id'>;
    readonly targetVisibility?: TargetVisibilitySnapshot;
  }): Promise<AuditRecordOutcome | 'skipped'> {
    if (input.outcome.status !== 'accepted') return 'skipped';
    return this.recordCampaign({
      event: input.audit,
      originMutationId: input.mutationId,
      targetVisibility: input.targetVisibility,
    });
  }

  /**
   * Authority path inside the domain transaction (`_db.md` Write Path): the routed insert
   * commits or rolls back with the domain write. An insert failure is isolated by the store
   * and parked in the outbox inside the same transaction; if that also fails the event
   * waits in memory. The caller's transaction is never aborted by audit.
   */
  async recordWithin(
    executor: AuditSqlExecutor,
    submission: CampaignAuditSubmission,
  ): Promise<AuditRecordOutcome> {
    const prepared = this.#prepareCampaign(submission);
    if ('invalid' in prepared) return this.#rejectInvalid(prepared, executor);
    try {
      const result = await this.#appender(prepared).appendWithin(executor, prepared);
      return result.status === 'inserted' ? 'recorded' : 'duplicate';
    } catch {
      return this.#defer(prepared, 'store_unavailable', 1, executor);
    }
  }

  /** One retry pass over in-memory and outbox entries that are due. Never throws. */
  retryPending(limit = 50): Promise<AuditRetryReport> {
    this.#retrying ??= this.#retryPass(limit).finally(() => {
      this.#retrying = undefined;
    });
    return this.#retrying;
  }

  /** Background retry loop; returns a stop function. The timer does not keep a process alive. */
  startRetryLoop(intervalMs = 30_000): () => void {
    const timer = setInterval(() => {
      void this.retryPending();
    }, intervalMs);
    (timer as { unref?: () => void }).unref?.();
    return () => clearInterval(timer);
  }

  /** Backlog for metrics/health. `undefined` outbox counts mean the outbox is unreachable. */
  async backlog(): Promise<{
    readonly memoryPending: number;
    readonly outboxPending?: number;
    readonly outboxDead?: number;
  }> {
    try {
      const counts = await this.#deps.outbox.backlog();
      return {
        memoryPending: this.#memory.size,
        outboxPending: counts.pending,
        outboxDead: counts.dead,
      };
    } catch {
      return { memoryPending: this.#memory.size };
    }
  }

  #prepareCampaign(
    submission: CampaignAuditSubmission,
  ): CampaignAuditEnvelope | InvalidAuditSubmission {
    const originMutationId = this.#origin(submission.originMutationId);
    const eventId = deriveAuditEventId(originMutationId);
    const rawEvent: unknown = { ...submission.event, id: eventId };
    const store = routeCampaignEvent(submission.event);
    const invalid = { store, eventId, originMutationId, invalid: rawEvent };
    if (
      originMutationId !== submission.originMutationId &&
      submission.originMutationId !== undefined
    ) {
      return invalid;
    }
    if (!isValidCampaignEvent(rawEvent)) return invalid;
    const event = rawEvent;
    const registry = this.#deps.registry;
    if (!registry.acceptsPayload(event.action, event)) return invalid;
    const targetVisibility =
      submission.targetVisibility ??
      registry.defaultVisibility(event.action) ??
      this.#declaredTargetVisibility(event.targetType) ??
      FAIL_CLOSED_VISIBILITY;
    if (!isValidVisibilitySnapshot(targetVisibility)) return invalid;
    return {
      store,
      eventId,
      originMutationId,
      event,
      targetVisibility,
      rendererVersion: registry.currentVersion(event.action),
    };
  }

  /** Never throws: a failing lookup or an invalid answer is treated as undeclared (GM-only). */
  #declaredTargetVisibility(targetType: string): TargetVisibilitySnapshot | undefined {
    try {
      const snapshot = this.#deps.targets?.snapshotFor(targetType);
      return isValidVisibilitySnapshot(snapshot) ? snapshot : undefined;
    } catch {
      return undefined;
    }
  }

  #prepareAccount(
    submission: AccountAuditSubmission,
  ): AccountAuditEnvelope | InvalidAuditSubmission {
    const originMutationId = this.#origin(submission.originMutationId);
    const eventId = deriveAuditEventId(originMutationId);
    const invalid = {
      store: 'account' as const,
      eventId,
      originMutationId,
      invalid: submission.event,
    };
    if (
      originMutationId !== submission.originMutationId &&
      submission.originMutationId !== undefined
    ) {
      return invalid;
    }
    if (!isValidAccountEvent(submission.event)) return invalid;
    if (!this.#deps.registry.acceptsPayload(submission.event.action, submission.event)) {
      return invalid;
    }
    return {
      store: 'account',
      eventId,
      originMutationId,
      event: submission.event,
      rendererVersion: this.#deps.registry.currentVersion(submission.event.action),
    };
  }

  /** A malformed supplied origin is replaced so the dead letter still has a valid key. */
  #origin(supplied: string | undefined): string {
    return supplied !== undefined && isAuditId(supplied) ? supplied : this.#newId();
  }

  async #rejectInvalid(
    submission: InvalidAuditSubmission,
    executor?: AuditSqlExecutor,
  ): Promise<AuditRecordOutcome> {
    const park: AuditParkInput = {
      envelope: submission,
      state: 'dead',
      code: 'invalid_event',
      attemptCount: 1,
      nextAttemptAt: this.#now(),
    };
    let parkedIn: AuditFailureSignal['parkedIn'] = 'outbox';
    try {
      if (executor === undefined) await this.#deps.outbox.park(park);
      else await this.#deps.outbox.parkWithin(executor, park);
    } catch {
      parkedIn = 'none';
    }
    this.#signal('deadLettered', submission, 'invalid_event', 1, parkedIn);
    return 'dead_lettered';
  }

  async #deliver(envelope: AuditEnvelope): Promise<AuditRecordOutcome> {
    try {
      const result = await this.#attempt(envelope);
      return result.status === 'inserted' ? 'recorded' : 'duplicate';
    } catch (error) {
      return this.#defer(
        envelope,
        error instanceof AuditAttemptTimeout ? 'store_timeout' : 'store_unavailable',
        1,
      );
    }
  }

  async #defer(
    envelope: AuditEnvelope,
    code: AuditFailureCode,
    attemptCount: number,
    executor?: AuditSqlExecutor,
  ): Promise<AuditRecordOutcome> {
    const nextAttemptAt = new Date(this.#now().getTime() + this.#delay(attemptCount));
    const park: AuditParkInput = { envelope, state: 'pending', code, attemptCount, nextAttemptAt };
    try {
      if (executor === undefined) await this.#deps.outbox.park(park);
      else await this.#deps.outbox.parkWithin(executor, park);
      this.#signal('degraded', envelope, code, attemptCount, 'outbox');
      return 'deferred';
    } catch {
      // Inside a caller transaction the commit outcome is unknown here; replaying from memory
      // could fabricate history for a rolled-back mutation, so this is an observable gap.
      if (executor !== undefined) {
        this.#signal('deadLettered', envelope, code, attemptCount, 'none');
        return 'dead_lettered';
      }
      return this.#remember(envelope, code, attemptCount, nextAttemptAt.getTime());
    }
  }

  #remember(
    envelope: AuditEnvelope,
    code: AuditFailureCode,
    attemptCount: number,
    nextAttemptAt: number,
  ): AuditRecordOutcome {
    if (!this.#memory.has(envelope.eventId) && this.#memory.size >= this.#memoryQueueLimit) {
      this.#signal('deadLettered', envelope, 'memory_queue_full', attemptCount, 'none');
      return 'dead_lettered';
    }
    this.#memory.set(envelope.eventId, { envelope, attemptCount, nextAttemptAt });
    this.#signal('degraded', envelope, code, attemptCount, 'memory');
    return 'deferred';
  }

  async #retryPass(limit: number): Promise<AuditRetryReport> {
    let repaired = 0;
    let deferred = 0;
    let deadLettered = 0;
    const now = this.#now().getTime();

    for (const entry of [...this.#memory.values()]) {
      if (entry.nextAttemptAt > now) continue;
      const attempt = entry.attemptCount + 1;
      try {
        await this.#attempt(entry.envelope);
        this.#memory.delete(entry.envelope.eventId);
        this.#repaired(entry.envelope, attempt);
        repaired += 1;
        continue;
      } catch {
        // Fall through to durable parking or memory backoff.
      }
      this.#memory.delete(entry.envelope.eventId);
      const outcome =
        attempt >= this.#maxAttempts
          ? await this.#exhaust(entry.envelope, attempt)
          : await this.#defer(entry.envelope, 'store_unavailable', attempt);
      if (outcome === 'dead_lettered') deadLettered += 1;
      else deferred += 1;
    }

    let due: readonly AuditRepairEntry[];
    try {
      due = await this.#deps.outbox.due(this.#now(), limit);
    } catch {
      return { repaired, deferred, deadLettered, outboxReadable: false };
    }
    for (const entry of due) {
      const attempt = entry.attemptCount + 1;
      try {
        await this.#attempt(entry.envelope);
      } catch {
        const outcome =
          attempt >= this.#maxAttempts
            ? await this.#exhaust(entry.envelope, attempt)
            : await this.#defer(entry.envelope, 'store_unavailable', attempt);
        if (outcome === 'dead_lettered') deadLettered += 1;
        else deferred += 1;
        continue;
      }
      try {
        await this.#deps.outbox.resolve(entry.envelope.eventId);
      } catch {
        // Stored exactly once already; the stale outbox row resolves as a duplicate next pass.
      }
      this.#repaired(entry.envelope, attempt);
      repaired += 1;
    }
    return { repaired, deferred, deadLettered, outboxReadable: true };
  }

  async #exhaust(envelope: AuditEnvelope, attempt: number): Promise<AuditRecordOutcome> {
    let parkedIn: AuditFailureSignal['parkedIn'] = 'outbox';
    try {
      await this.#deps.outbox.park({
        envelope,
        state: 'dead',
        code: 'retry_exhausted',
        attemptCount: attempt,
        nextAttemptAt: this.#now(),
      });
    } catch {
      parkedIn = 'none';
    }
    this.#signal('deadLettered', envelope, 'retry_exhausted', attempt, parkedIn);
    return 'dead_lettered';
  }

  #attempt(envelope: AuditEnvelope): Promise<AuditAppendResult> {
    const pending = this.#appendRouted(envelope);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new AuditAttemptTimeout()), this.#attemptTimeoutMs);
    });
    return Promise.race([pending, timeout]).finally(() => clearTimeout(timer));
  }

  #appendRouted(envelope: AuditEnvelope): Promise<AuditAppendResult> {
    return envelope.store === 'account'
      ? this.#deps.account.append(envelope)
      : this.#appender(envelope).append(envelope);
  }

  #appender(envelope: CampaignAuditEnvelope): AuditAppender<CampaignAuditEnvelope> {
    return envelope.store === 'private' ? this.#deps.private : this.#deps.campaign;
  }

  #delay(attemptCount: number): number {
    return Math.min(this.#maxDelayMs, this.#baseDelayMs * 2 ** Math.max(0, attemptCount - 1));
  }

  #repaired(envelope: AuditEnvelope, attempt: number): void {
    try {
      this.#deps.diagnostics.repaired(signalIds(envelope, attempt));
    } catch {
      // See #signal.
    }
  }

  #signal(
    kind: 'degraded' | 'deadLettered',
    envelope: Pick<AuditEnvelope, 'eventId' | 'originMutationId' | 'store'>,
    code: AuditFailureCode,
    attempt: number,
    parkedIn: AuditFailureSignal['parkedIn'],
  ): void {
    try {
      this.#deps.diagnostics[kind]({ ...signalIds(envelope, attempt), code, parkedIn });
    } catch {
      // Diagnostics must never turn an audit fault into a caller failure.
    }
  }
}

function signalIds(
  envelope: Pick<AuditEnvelope, 'eventId' | 'originMutationId' | 'store'>,
  attempt: number,
): Omit<AuditFailureSignal, 'code' | 'parkedIn'> {
  return {
    eventId: envelope.eventId,
    originMutationId: envelope.originMutationId,
    store: envelope.store,
    attempt,
  };
}
