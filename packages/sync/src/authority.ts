import type { ActorRef, AuditEvent } from '@rpg/contracts';
import type {
  ApplierOutcome,
  AuthoredMutationAudit,
  MutationApplier,
  MutationAuditHook,
  MutationAuditParticipant,
  MutationBatch,
  MutationOutcome,
  PendingMutation,
} from './model.ts';

export interface CurrentAccessResolver {
  resolve(userId: string, campaignId: string): Promise<ActorRef | undefined>;
  /**
   * Current access read on an applier's open write transaction (same database, opaque handle) and
   * locked until it ends: a removal or role change commits before this read, which then sees it,
   * or waits for the write to finish. Absent means no such check (test doubles only).
   */
  resolveWithin?(
    transaction: unknown,
    userId: string,
    campaignId: string,
  ): Promise<ActorRef | undefined>;
}

export interface MutationReceiptStore {
  get(mutationId: string): Promise<MutationOutcome | undefined>;
  save(campaignId: string, outcome: MutationOutcome): Promise<void>;
  runExclusive<T>(mutationId: string, task: () => Promise<T>): Promise<T>;
}

export class InMemoryMutationReceiptStore implements MutationReceiptStore {
  readonly #outcomes = new Map<string, MutationOutcome>();
  readonly #locks = new Map<string, Promise<void>>();

  async get(mutationId: string): Promise<MutationOutcome | undefined> {
    return this.#outcomes.get(mutationId);
  }

  async save(_campaignId: string, outcome: MutationOutcome): Promise<void> {
    this.#outcomes.set(outcome.mutationId, structuredClone(outcome));
  }

  async runExclusive<T>(mutationId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(mutationId) ?? Promise.resolve();
    let release: () => void = () => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#locks.set(mutationId, current);
    await previous;
    try {
      return await task();
    } finally {
      release();
      if (this.#locks.get(mutationId) === current) this.#locks.delete(mutationId);
    }
  }
}

export class MutationApplierRegistry {
  readonly #appliers = new Map<string, MutationApplier>();

  register(applier: MutationApplier): void {
    const key = mutationKey(applier.featureId, applier.tableName);
    if (this.#appliers.has(key)) throw new Error('duplicate_mutation_applier');
    if (
      applier.applyCreation !== undefined &&
      [...this.#appliers.values()].some((registered) => registered.applyCreation !== undefined)
    ) {
      throw new Error('duplicate_creation_applier');
    }
    this.#appliers.set(key, applier);
  }

  get(featureId: string, tableName: string): MutationApplier | undefined {
    return this.#appliers.get(mutationKey(featureId, tableName));
  }
}

export class AuthorityMutationService {
  constructor(
    private readonly access: CurrentAccessResolver,
    private readonly appliers: MutationApplierRegistry,
    private readonly receipts: MutationReceiptStore,
    /** Absent in deployments without audit; the domain services then audit on their own. */
    private readonly audit?: MutationAuditParticipant,
  ) {}

  /**
   * `options.sessionId` is the authenticated session that uploaded the batch (B-2); the route
   * passes it from the session cookie and appliers receive it as `context.sessionId`.
   */
  async apply(
    userId: string,
    batch: MutationBatch,
    options: { readonly sessionId?: string } = {},
  ): Promise<readonly MutationOutcome[]> {
    if (!isCausallyOrdered(batch)) {
      return batch.mutations.map((mutation) => ({
        mutationId: mutation.mutationId,
        status: 'error' as const,
        code: 'causal_order_invalid',
        retryable: false,
      }));
    }

    const outcomes: MutationOutcome[] = [];
    for (const mutation of batch.mutations) {
      outcomes.push(
        await this.receipts.runExclusive(mutation.mutationId, async () => {
          const existing = await this.receipts.get(mutation.mutationId);
          if (existing !== undefined) {
            // Replay (lost acknowledgement): repeating the idempotent audit call repairs an
            // attempt that was interrupted after the receipt became durable.
            await this.#recordAudit(
              batch,
              mutation,
              existing,
              await this.access.resolve(userId, batch.campaignId),
            );
            return existing;
          }
          const { applied, actor, auditHeld, authored } = await this.#authorizeAndApply(
            userId,
            batch,
            mutation,
            options.sessionId,
          );
          const outcome = toMutationOutcome(mutation.mutationId, applied);
          // A retryable failure must stay retryable: persisting it would replay it forever.
          if (outcome.status !== 'error' || !outcome.retryable) {
            await this.receipts.save(batch.campaignId, outcome);
          }
          // Held by the domain transaction: it committed with the write (accepted) or rolled
          // back with it. Otherwise fall back to the idempotent after-commit path.
          if (!auditHeld) await this.#recordAudit(batch, mutation, outcome, actor, authored);
          return outcome;
        }),
      );
    }
    return outcomes;
  }

  /**
   * Feature 06 after-commit path, once the applier result and receipt are durable: the fallback
   * when the domain transaction did not hold the event, and the repair on every replay. The
   * origin ID is the client mutation ID, so retries and replays store one event; a conflict or
   * error stores none. Audit trouble never changes the outcome returned to the client.
   */
  async #recordAudit(
    batch: MutationBatch,
    mutation: PendingMutation,
    outcome: MutationOutcome,
    actor: ActorRef | undefined,
    authored?: AuthoredMutationAudit,
  ): Promise<void> {
    const audit = bindAudit(batch, mutation, actor, authored);
    if (this.audit === undefined || audit === undefined) return;
    try {
      await this.audit.recordMutationOutcome({
        mutationId: mutation.mutationId,
        outcome,
        audit,
        ...(authored?.targetVisibility === undefined
          ? {}
          : { targetVisibility: authored.targetVisibility }),
      });
    } catch {
      // Contract: participants do not throw. A defect here must still never fail the mutation.
    }
  }

  /**
   * Feature 06 same-transaction path (`_db.md` Write Path): the applier calls the hook inside its
   * domain transaction after the accepted write matched, so the write and its single audit
   * insert (or repair-outbox entry) commit or roll back together. Only offered when the mutation
   * carries an envelope and the participant supports it; `held()` stays false when the applier
   * never calls it or the participant could not hold the event, which selects the fallback.
   */
  #transactionalAudit(
    batch: MutationBatch,
    mutation: PendingMutation,
    actor: ActorRef,
    fence?: (transaction: unknown) => Promise<void>,
  ): {
    readonly hook?: MutationAuditHook;
    held(): boolean;
    /** The server-authored event the applier passed, kept for the after-commit fallback. */
    authored(): AuthoredMutationAudit | undefined;
  } {
    const participant = this.audit;
    const envelope = bindAudit(batch, mutation, actor);
    const audited = participant?.recordAcceptedWithin !== undefined && envelope !== undefined;
    if (!audited && fence === undefined) {
      return { held: () => false, authored: () => undefined };
    }
    let called = false;
    let held = false;
    let authoredEvent: AuthoredMutationAudit | undefined;
    return {
      hook: async (transaction, authored) => {
        if (called) return;
        called = true;
        // Outside the try below: a changed access (or a failed check) must abort the write.
        await fence?.(transaction);
        authoredEvent = authored;
        if (participant?.recordAcceptedWithin === undefined || envelope === undefined) return;
        const audit = bindAudit(batch, mutation, actor, authored) ?? envelope;
        try {
          held =
            (await participant.recordAcceptedWithin(transaction, {
              mutationId: mutation.mutationId,
              audit,
              ...(authored?.targetVisibility === undefined
                ? {}
                : { targetVisibility: authored.targetVisibility }),
            })) === true;
        } catch {
          // Never abort the user's write over audit; the after-commit path records it instead.
          held = false;
        }
      },
      held: () => held,
      authored: () => authoredEvent,
    };
  }

  /**
   * Every item re-resolves current membership. With none, only the campaign-create mutation may
   * proceed, through the applier's creation scope; the creator must resolve as a current member
   * once it commits, otherwise the item fails closed. Later items resolve membership normally.
   */
  async #authorizeAndApply(
    userId: string,
    batch: MutationBatch,
    mutation: PendingMutation,
    sessionId: string | undefined,
  ): Promise<{
    readonly applied: ApplierOutcome;
    readonly actor?: ActorRef;
    readonly auditHeld: boolean;
    readonly authored?: AuthoredMutationAudit;
  }> {
    if (mutation.campaignId !== batch.campaignId) return { applied: DENIED, auditHeld: false };
    const applier = this.appliers.get(mutation.featureId, mutation.tableName);
    const actor = await this.access.resolve(userId, batch.campaignId);
    if (actor !== undefined) {
      if (applier === undefined) return { applied: UNREGISTERED, actor, auditHeld: false };
      const fence = this.#accessFence(actor);
      const audit = this.#transactionalAudit(batch, mutation, actor, fence.check);
      try {
        const applied = await applier.apply({
          actor,
          mutation,
          ...(audit.hook === undefined ? {} : { recordAudit: audit.hook }),
          ...(sessionId === undefined ? {} : { sessionId }),
        });
        const lost = fence.lost();
        return lost !== undefined
          ? { applied: lost, auditHeld: false }
          : { applied, actor, auditHeld: audit.held(), authored: audit.authored() };
      } catch (error) {
        const lost = fence.lost();
        if (lost === undefined) throw error;
        return { applied: lost, auditHeld: false };
      }
    }
    if (applier?.applyCreation === undefined || !isCampaignCreation(mutation)) {
      return { applied: DENIED, auditHeld: false };
    }
    // The applier commits the creator's owner membership in the same transaction as the event.
    const audit = this.#transactionalAudit(batch, mutation, {
      userId,
      campaignId: mutation.campaignId,
      role: 'owner',
    });
    const created = await applier.applyCreation({
      creatorUserId: userId,
      mutation,
      ...(audit.hook === undefined ? {} : { recordAudit: audit.hook }),
    });
    const auditHeld = audit.held();
    // A non-member never sees authority state of an existing record through a conflict.
    if (created.status === 'conflict') return { applied: DENIED, auditHeld };
    if (created.status !== 'accepted') return { applied: created, auditHeld };
    const creator = await this.access.resolve(userId, batch.campaignId);
    return creator === undefined
      ? { applied: DENIED, auditHeld }
      : { applied: created, actor: creator, auditHeld };
  }

  /**
   * Closes the window between authorizing a mutation and committing it (feature 03 `_domain.md`:
   * a revoked member's queued changes are never applied). `check` runs through the hook every
   * applier calls inside its write transaction; throwing rolls that transaction back whatever the
   * applier then reports, so `lost()` replaces its outcome. Revoked is terminal. A changed role is
   * retryable, so the next attempt authorizes under the new role.
   */
  #accessFence(actor: ActorRef): {
    readonly check?: (transaction: unknown) => Promise<void>;
    lost(): ApplierOutcome | undefined;
  } {
    const resolver = this.access;
    if (resolver.resolveWithin === undefined) return { lost: () => undefined };
    let lost: ApplierOutcome | undefined;
    return {
      check: async (transaction) => {
        const current = await resolver.resolveWithin?.(transaction, actor.userId, actor.campaignId);
        if (current?.role === actor.role) return;
        lost = current === undefined ? DENIED : ROLE_CHANGED;
        throw new Error('access changed during the write');
      },
      lost: () => lost,
    };
  }
}

const DENIED: ApplierOutcome = {
  status: 'error',
  code: 'not_found_or_forbidden',
  retryable: false,
};
const ROLE_CHANGED: ApplierOutcome = {
  status: 'error',
  code: 'authority_unavailable',
  retryable: true,
};
const UNREGISTERED: ApplierOutcome = {
  status: 'error',
  code: 'unregistered_mutation',
  retryable: false,
};

/**
 * Binds the uploaded payload to the mutation (campaign, target) and to the actor the authority
 * resolved, never to what the client claimed. `undefined` means nothing may be audited.
 */
function bindAudit(
  batch: MutationBatch,
  mutation: PendingMutation,
  actor: ActorRef | undefined,
  authored?: AuthoredMutationAudit,
): Omit<AuditEvent, 'id'> | undefined {
  if (mutation.audit === undefined || actor === undefined) return undefined;
  if (mutation.campaignId !== batch.campaignId) return undefined;
  if (authored !== undefined) {
    // Server-authored content replaces every client-composed field; the binding is unchanged.
    return {
      campaignId: mutation.campaignId,
      ...(mutation.audit.sessionId === undefined ? {} : { sessionId: mutation.audit.sessionId }),
      actor,
      action: authored.action,
      targetType: authored.targetType,
      targetId: mutation.recordId,
      ...(authored.before === undefined ? {} : { before: authored.before }),
      ...(authored.after === undefined ? {} : { after: authored.after }),
      at: mutation.audit.at,
      private: false,
    };
  }
  return {
    ...mutation.audit,
    campaignId: mutation.campaignId,
    targetType: mutation.tableName,
    targetId: mutation.recordId,
    actor,
  };
}

/** The only mutation that may be authorized without an existing membership. */
export function isCampaignCreation(mutation: PendingMutation): boolean {
  return (
    mutation.operation === 'insert' &&
    mutation.expectedVersion === null &&
    mutation.recordId === mutation.campaignId
  );
}

function toMutationOutcome(mutationId: string, outcome: ApplierOutcome): MutationOutcome {
  if (outcome.status === 'accepted') {
    return {
      mutationId,
      status: 'accepted',
      acceptedVersion: outcome.version,
      serverCursor: outcome.cursor,
    };
  }
  return { mutationId, ...outcome };
}

function mutationKey(featureId: string, tableName: string): string {
  return `${featureId}:${tableName}`;
}

function isCausallyOrdered(batch: MutationBatch): boolean {
  let previous = -1;
  for (const mutation of batch.mutations) {
    if (mutation.causalSequence <= previous) return false;
    previous = mutation.causalSequence;
  }
  return true;
}
