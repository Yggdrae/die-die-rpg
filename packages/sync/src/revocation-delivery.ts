import type { CampaignAccessRevocationPublisher, CampaignAccessRevoked } from '@rpg/contracts';

/**
 * Durable, retryable delivery of feature 01's committed `CampaignAccessRevoked` facts (feature 03
 * task 07). Delivery invalidates connected access only; it never restores or changes membership,
 * because every server path re-resolves current membership on each request.
 */

export type RevocationDeliveryState = 'pending' | 'delivered' | 'failed';

export interface RevocationDelivery {
  readonly deliveryId: string;
  readonly event: CampaignAccessRevoked;
  readonly state: RevocationDeliveryState;
  readonly attemptCount: number;
  readonly nextAttemptAt: string;
  readonly lastErrorCode?: string;
}

export interface RevocationDeliveryBacklog {
  readonly pending: number;
  readonly failed: number;
  readonly oldestPendingAt?: string;
}

/** Outbox port. `enqueue` is idempotent by (campaign, user, membership version, reason). */
export interface RevocationDeliveryOutbox {
  enqueue(event: CampaignAccessRevoked): Promise<RevocationDelivery>;
  due(now: Date, limit: number): Promise<readonly RevocationDelivery[]>;
  delivered(deliveryId: string, at: Date): Promise<void>;
  /** `nextAttemptAt === undefined` makes the failure terminal (`failed`). */
  attemptFailed(
    deliveryId: string,
    input: { readonly code: string; readonly at: Date; readonly nextAttemptAt?: Date },
  ): Promise<void>;
  backlog(): Promise<RevocationDeliveryBacklog>;
}

/** One way connected access is cut (subscription registry, provider session, ...). Idempotent. */
export interface ConnectedAccessInvalidator {
  invalidate(event: CampaignAccessRevoked): Promise<void>;
}

export interface RevocationDeliveryDiagnostics {
  deliveryRetrying(delivery: RevocationDelivery, code: string, nextAttemptAt: Date): void;
  deliveryFailed(delivery: RevocationDelivery, code: string): void;
}

export interface RevocationDeliveryPassResult {
  readonly delivered: number;
  readonly retrying: number;
  readonly failed: number;
}

/** Access loss: the user's replicas must be destroyed. Role/ownership changes re-filter only. */
export function revokesReplicaAccess(event: CampaignAccessRevoked): boolean {
  return event.reason === 'removed' || event.reason === 'signed_out';
}

export class DurableRevocationPublisher implements CampaignAccessRevocationPublisher {
  readonly #maxAttempts: number;
  readonly #baseBackoffMs: number;
  readonly #maxBackoffMs: number;
  readonly #clock: () => Date;

  constructor(
    private readonly outbox: RevocationDeliveryOutbox,
    private readonly invalidators: readonly ConnectedAccessInvalidator[],
    private readonly diagnostics: RevocationDeliveryDiagnostics,
    options: {
      readonly maxAttempts?: number;
      readonly baseBackoffMs?: number;
      readonly maxBackoffMs?: number;
      readonly clock?: () => Date;
    } = {},
  ) {
    this.#maxAttempts = options.maxAttempts ?? 10;
    this.#baseBackoffMs = options.baseBackoffMs ?? 5_000;
    this.#maxBackoffMs = options.maxBackoffMs ?? 15 * 60_000;
    this.#clock = options.clock ?? (() => new Date());
  }

  /**
   * Records the fact durably, then tries delivery once. Only an outbox write failure throws
   * (feature 01 then logs `integrationDegraded`); a delivery failure stays queued for retry.
   */
  async publish(event: CampaignAccessRevoked): Promise<void> {
    const delivery = await this.outbox.enqueue(event);
    // A duplicate of an already-attempted fact waits for its backoff in the retry pass.
    if (delivery.state === 'pending' && delivery.attemptCount === 0) await this.#attempt(delivery);
  }

  /** One retry pass over due deliveries. */
  async retryDue(limit = 50): Promise<RevocationDeliveryPassResult> {
    const result = { delivered: 0, retrying: 0, failed: 0 };
    for (const delivery of await this.outbox.due(this.#clock(), limit)) {
      result[await this.#attempt(delivery)] += 1;
    }
    return result;
  }

  backlog(): Promise<RevocationDeliveryBacklog> {
    return this.outbox.backlog();
  }

  startRetryLoop(intervalMs = 30_000): () => void {
    let running = false;
    const timer = setInterval(() => {
      if (running) return;
      running = true;
      void this.retryDue()
        .catch(() => undefined)
        .finally(() => {
          running = false;
        });
    }, intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  async #attempt(delivery: RevocationDelivery): Promise<'delivered' | 'retrying' | 'failed'> {
    try {
      for (const invalidator of this.invalidators) await invalidator.invalidate(delivery.event);
      await this.outbox.delivered(delivery.deliveryId, this.#clock());
      return 'delivered';
    } catch (error) {
      const code = safeCode(error);
      const attempt = delivery.attemptCount + 1;
      const at = this.#clock();
      if (attempt >= this.#maxAttempts) {
        await this.outbox.attemptFailed(delivery.deliveryId, { code, at });
        this.diagnostics.deliveryFailed({ ...delivery, attemptCount: attempt }, code);
        return 'failed';
      }
      const delay = Math.min(this.#maxBackoffMs, this.#baseBackoffMs * 2 ** (attempt - 1));
      const nextAttemptAt = new Date(at.getTime() + delay);
      await this.outbox.attemptFailed(delivery.deliveryId, { code, at, nextAttemptAt });
      this.diagnostics.deliveryRetrying(
        { ...delivery, attemptCount: attempt },
        code,
        nextAttemptAt,
      );
      return 'retrying';
    }
  }
}

/** Test/development outbox with the same idempotency and state rules as the PostgreSQL one. */
export class InMemoryRevocationDeliveryOutbox implements RevocationDeliveryOutbox {
  readonly #deliveries = new Map<string, RevocationDelivery>();

  async enqueue(event: CampaignAccessRevoked): Promise<RevocationDelivery> {
    const existing = [...this.#deliveries.values()].find(
      (delivery) => deliveryKey(delivery.event) === deliveryKey(event),
    );
    if (existing !== undefined) return existing;
    const delivery: RevocationDelivery = {
      deliveryId: crypto.randomUUID(),
      event: structuredClone(event),
      state: 'pending',
      attemptCount: 0,
      nextAttemptAt: event.committedAt,
    };
    this.#deliveries.set(delivery.deliveryId, delivery);
    return delivery;
  }

  async due(now: Date, limit: number): Promise<readonly RevocationDelivery[]> {
    return [...this.#deliveries.values()]
      .filter(
        (delivery) =>
          delivery.state === 'pending' && Date.parse(delivery.nextAttemptAt) <= now.getTime(),
      )
      .slice(0, limit);
  }

  async delivered(deliveryId: string): Promise<void> {
    this.#update(deliveryId, { state: 'delivered' });
  }

  async attemptFailed(
    deliveryId: string,
    input: { readonly code: string; readonly at: Date; readonly nextAttemptAt?: Date },
  ): Promise<void> {
    const current = this.#deliveries.get(deliveryId);
    if (current === undefined) return;
    this.#update(deliveryId, {
      state: input.nextAttemptAt === undefined ? 'failed' : 'pending',
      attemptCount: current.attemptCount + 1,
      nextAttemptAt: (input.nextAttemptAt ?? input.at).toISOString(),
      lastErrorCode: input.code,
    });
  }

  async backlog(): Promise<RevocationDeliveryBacklog> {
    const pending = [...this.#deliveries.values()].filter((item) => item.state === 'pending');
    const oldest = pending.map((item) => item.event.committedAt).sort()[0];
    return {
      pending: pending.length,
      failed: [...this.#deliveries.values()].filter((item) => item.state === 'failed').length,
      ...(oldest === undefined ? {} : { oldestPendingAt: oldest }),
    };
  }

  list(): readonly RevocationDelivery[] {
    return [...this.#deliveries.values()];
  }

  #update(deliveryId: string, patch: Partial<RevocationDelivery>): void {
    const current = this.#deliveries.get(deliveryId);
    if (current !== undefined) this.#deliveries.set(deliveryId, { ...current, ...patch });
  }
}

function deliveryKey(event: CampaignAccessRevoked): string {
  return `${event.campaignId}:${event.userId}:${event.membershipVersion}:${event.reason}`;
}

/** Error class/code only; never a message that could carry SQL or user content. */
function safeCode(error: unknown): string {
  if (error !== null && typeof error === 'object' && 'code' in error) {
    const code = (error as { readonly code: unknown }).code;
    if (typeof code === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(code)) return code;
  }
  return 'delivery_error';
}
