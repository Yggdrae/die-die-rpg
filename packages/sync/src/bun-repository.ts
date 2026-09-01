import type {
  ActorRef,
  ConflictChannel,
  DeferredConflict,
  EntityEnvelope,
  Id,
  ListOptions,
  RepositoryError,
  Result,
  SyncedRepository,
  Version,
} from '@rpg/contracts';
import type { SqliteReplicaStore } from './bun-sqlite.ts';
import { Channel } from './channel.ts';
import type {
  ConflictResolutionChoice,
  ConflictResolutionResult,
  MutationConflict,
  MutationUploader,
} from './model.ts';
import type { SyncStatusStore } from './status.ts';

export class ConflictHub {
  readonly #channel = new Channel<MutationConflict>();

  channel(tableName: string): ConflictChannel {
    return {
      subscribe: (listener) =>
        this.#channel.subscribe((conflict) => {
          if (conflict.table === tableName) listener(conflict);
        }),
    };
  }

  emit(conflict: MutationConflict): void {
    this.#channel.emit(conflict);
  }
}

export class SqliteSyncedRepository<T extends EntityEnvelope> implements SyncedRepository<T> {
  readonly conflicts: ConflictChannel;

  constructor(
    private readonly store: SqliteReplicaStore,
    private readonly tableName: string,
    private readonly featureId: string,
    private readonly actor: ActorRef,
    private readonly status: SyncStatusStore,
    conflictHub: ConflictHub,
    private readonly clock: () => Date = () => new Date(),
    private readonly createId: () => string = () => crypto.randomUUID(),
  ) {
    this.conflicts = conflictHub.channel(tableName);
  }

  async get(id: Id): Promise<Result<T, RepositoryError>> {
    return this.store.get<T>(this.tableName, id);
  }

  async list(campaignId: Id, options: ListOptions = {}): Promise<Result<T[], RepositoryError>> {
    return {
      ok: true,
      value: this.store.list<T>(this.tableName, campaignId, options),
    };
  }

  async upsert(value: T, expectedVersion: Version | null): Promise<Result<T, RepositoryError>> {
    const now = timestamp(this.clock());
    const result = this.store.write({
      tableName: this.tableName,
      featureId: this.featureId,
      value,
      expectedVersion,
      operation: expectedVersion === null ? 'insert' : 'update',
      mutationId: this.createId(),
      recordedAt: now,
      audit: {
        campaignId: value.campaignId,
        actor: this.actor,
        action:
          expectedVersion === null ? `${this.featureId}.created` : `${this.featureId}.updated`,
        targetType: this.tableName,
        targetId: value.id,
        after: { version: expectedVersion === null ? 1 : expectedVersion + 1 },
        at: now,
        private: value.visibility.mode === 'gm_only',
      },
    });
    if (!result.ok) return result;
    this.status.setPendingCount(result.value.pendingCount);
    return { ok: true, value: result.value.value };
  }

  async softDelete(id: Id, expectedVersion: Version): Promise<Result<void, RepositoryError>> {
    const now = timestamp(this.clock());
    const result = this.store.softDelete<T>({
      tableName: this.tableName,
      featureId: this.featureId,
      id,
      expectedVersion,
      mutationId: this.createId(),
      recordedAt: now,
      audit: {
        campaignId: this.actor.campaignId,
        actor: this.actor,
        action: `${this.featureId}.deleted`,
        targetType: this.tableName,
        targetId: id,
        before: { version: expectedVersion },
        at: now,
        private: false,
      },
    });
    if (!result.ok) return result;
    this.status.setPendingCount(result.value.pendingCount);
    return { ok: true, value: undefined };
  }
}

export class MutationQueue {
  constructor(
    private readonly store: SqliteReplicaStore,
    private readonly status: SyncStatusStore,
    private readonly conflicts: ConflictHub,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async drain(
    campaignId: string,
    replicaId: string,
    uploader: MutationUploader,
  ): Promise<readonly DeferredConflict[]> {
    if (!this.status.snapshot().connected) return [];
    const mutations = this.store.pending(campaignId);
    if (mutations.length === 0) {
      this.status.setPendingCount(this.store.pendingCount(campaignId));
      return [];
    }
    this.store.markUploading(mutations.map((mutation) => mutation.mutationId));
    try {
      const outcomes = await uploader.upload({ campaignId, replicaId, mutations });
      const expected = new Set(mutations.map((mutation) => mutation.mutationId));
      if (
        outcomes.length !== mutations.length ||
        outcomes.some((outcome) => !expected.has(outcome.mutationId))
      ) {
        this.status.fail('invalid_upload_outcome');
        return [];
      }
      const found = this.store.applyOutcomes(outcomes, timestamp(this.clock()));
      for (const conflict of found) this.conflicts.emit(conflict);
      this.status.setPendingCount(this.store.pendingCount(campaignId));
      if (outcomes.some((outcome) => outcome.status === 'error')) {
        this.status.fail('upload_rejected');
      } else if (found.length === 0 && this.store.pendingCount(campaignId) === 0) {
        this.status.synchronized(timestamp(this.clock()));
      }
      return found;
    } catch {
      this.status.fail('sync_transport_error');
      this.status.setPendingCount(this.store.pendingCount(campaignId));
      return [];
    }
  }
}

export class ConflictResolutionService {
  constructor(
    private readonly store: SqliteReplicaStore,
    private readonly status: SyncStatusStore,
    private readonly resolverUserId: string,
    private readonly clock: () => Date = () => new Date(),
    private readonly createId: () => string = () => crypto.randomUUID(),
  ) {}

  resolve(input: {
    readonly conflictId: string;
    readonly choice: ConflictResolutionChoice;
    readonly manualValue?: unknown;
  }): Result<ConflictResolutionResult, RepositoryError> {
    const result = this.store.resolveConflict({
      conflictId: input.conflictId,
      choice: input.choice,
      resolverUserId: this.resolverUserId,
      resolvedAt: timestamp(this.clock()),
      ...(input.choice === 'keep_authority' ? {} : { mutationId: this.createId() }),
      ...(input.manualValue === undefined ? {} : { manualValue: input.manualValue }),
    });
    if (result.ok) this.status.setPendingCount(this.store.pendingCount());
    return result;
  }
}

export class ReplicaManager {
  constructor(
    private readonly store: SqliteReplicaStore,
    private readonly status: SyncStatusStore,
  ) {}

  revoke(campaignId: string): void {
    this.store.dropCampaign(campaignId);
    this.status.setPendingCount(this.store.pendingCount());
  }

  signOut(): void {
    for (const campaignId of this.store.campaignIds()) this.store.dropCampaign(campaignId);
    this.status.setPendingCount(0);
    this.status.setConnected(false);
  }
}

function timestamp(value: Date): string {
  return value.toISOString().replace(/\.\d{3}Z$/, 'Z');
}
