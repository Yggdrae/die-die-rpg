import type { ActorRef } from '@rpg/contracts';
import type { ApplierOutcome, MutationApplier, MutationBatch, MutationOutcome } from './model.ts';

export interface CurrentAccessResolver {
  resolve(userId: string, campaignId: string): Promise<ActorRef | undefined>;
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
  ) {}

  async apply(userId: string, batch: MutationBatch): Promise<readonly MutationOutcome[]> {
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
          if (existing !== undefined) return existing;
          const actor = await this.access.resolve(userId, batch.campaignId);
          if (actor === undefined || mutation.campaignId !== batch.campaignId) {
            const denied: MutationOutcome = {
              mutationId: mutation.mutationId,
              status: 'error',
              code: 'not_found_or_forbidden',
              retryable: false,
            };
            await this.receipts.save(batch.campaignId, denied);
            return denied;
          }
          const applier = this.appliers.get(mutation.featureId, mutation.tableName);
          const applied =
            applier === undefined
              ? ({ status: 'error', code: 'unregistered_mutation', retryable: false } as const)
              : await applier.apply({ actor, mutation });
          const outcome = toMutationOutcome(mutation.mutationId, applied);
          await this.receipts.save(batch.campaignId, outcome);
          return outcome;
        }),
      );
    }
    return outcomes;
  }
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
