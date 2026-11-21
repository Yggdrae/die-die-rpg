import type {
  ActorRef,
  ConflictChannel,
  DeferredConflict,
  EntityEnvelope,
  Id,
  ListOptions,
  ReplicaPurged,
  ReplicaPurgeListener,
  ReplicaPurgeReason,
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
  MutationDrainReport,
  MutationOutcome,
  MutationUploader,
} from './model.ts';
import type { ReplicaPurgeResult } from './replica-access.ts';
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

  /** Drains one ordered batch; returns only the deferred conflicts it raised. */
  async drain(
    campaignId: string,
    replicaId: string,
    uploader: MutationUploader,
  ): Promise<readonly DeferredConflict[]> {
    return (await this.drainWithOutcomes(campaignId, replicaId, uploader)).conflicts;
  }

  /**
   * Drains one ordered batch and reports every item's authority outcome in causal order, so a
   * consuming feature can act on acceptance (e.g. queue invitations after campaign creation).
   */
  async drainWithOutcomes(
    campaignId: string,
    replicaId: string,
    uploader: MutationUploader,
  ): Promise<MutationDrainReport> {
    if (!this.status.snapshot().connected) return { state: 'offline', outcomes: [], conflicts: [] };
    const mutations = this.store.pending(campaignId);
    if (mutations.length === 0) {
      this.status.setPendingCount(this.store.pendingCount(campaignId));
      return { state: 'empty', outcomes: [], conflicts: [] };
    }
    this.store.markUploading(mutations.map((mutation) => mutation.mutationId));
    try {
      const outcomes = await uploader.upload({ campaignId, replicaId, mutations });
      const byId = new Map(outcomes.map((outcome) => [outcome.mutationId, outcome]));
      if (
        outcomes.length !== mutations.length ||
        byId.size !== mutations.length ||
        mutations.some((mutation) => !byId.has(mutation.mutationId))
      ) {
        this.status.fail('invalid_upload_outcome');
        return { state: 'invalid_outcome', outcomes: [], conflicts: [] };
      }
      const found = this.store.applyOutcomes(outcomes, timestamp(this.clock()));
      for (const conflict of found) this.conflicts.emit(conflict);
      this.status.setPendingCount(this.store.pendingCount(campaignId));
      if (outcomes.some((outcome) => outcome.status === 'error')) {
        this.status.fail('upload_rejected');
      } else if (found.length === 0 && this.store.pendingCount(campaignId) === 0) {
        this.status.synchronized(timestamp(this.clock()));
      }
      return {
        state: 'uploaded',
        conflicts: found,
        outcomes: mutations.map((mutation) => {
          const outcome = byId.get(mutation.mutationId) as MutationOutcome;
          return {
            mutationId: mutation.mutationId,
            campaignId: mutation.campaignId,
            featureId: mutation.featureId,
            tableName: mutation.tableName,
            recordId: mutation.recordId,
            operation: mutation.operation,
            result:
              outcome.status === 'error'
                ? outcome.retryable
                  ? 'retry'
                  : 'rejected'
                : outcome.status,
            outcome,
          };
        }),
      };
    } catch {
      this.status.fail('sync_transport_error');
      this.status.setPendingCount(this.store.pendingCount(campaignId));
      return { state: 'transport_error', outcomes: [], conflicts: [] };
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

/**
 * Destroys campaign replicas. The local drop is synchronous and complete (records, queue, audit
 * envelopes, conflicts, holds, watermarks, state) before any listener runs, so a concurrent drain
 * finds no pending work and later outcomes for dropped mutations are ignored.
 */
export class ReplicaManager {
  constructor(
    private readonly store: SqliteReplicaStore,
    private readonly status: SyncStatusStore,
    private readonly listeners: readonly ReplicaPurgeListener[] = [],
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /**
   * `access_revoked` keeps the cached membership tombstone (so a stale delivery cannot restore
   * access and local writes stay refused); other reasons clear the cached membership too.
   */
  async purge(campaignId: string, reason: ReplicaPurgeReason): Promise<ReplicaPurgeResult> {
    const replicaId = this.store.replicaId(campaignId);
    const purgedAt = timestamp(this.clock());
    this.store.dropCampaign(campaignId);
    const cached = this.store.cachedMembership(campaignId);
    if (reason !== 'access_revoked') this.store.deleteMembership(campaignId);
    else if (cached !== undefined && cached.removedAt === null) {
      // Revoked without a delivered tombstone (bootstrap denial): tombstone the cache locally.
      this.store.putMembership({ ...cached, removedAt: purgedAt });
    }
    this.status.setPendingCount(this.store.pendingCount());
    const event: ReplicaPurged = { campaignId, replicaId, reason, purgedAt };
    const settled = await Promise.allSettled(
      this.listeners.map((listener) => listener.replicaPurged(event)),
    );
    return {
      event,
      listenerErrors: settled.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : [],
      ),
    };
  }

  revoke(campaignId: string): Promise<ReplicaPurgeResult> {
    return this.purge(campaignId, 'access_revoked');
  }

  /** Clears every campaign replica and the whole membership cache. */
  async signOut(): Promise<readonly ReplicaPurgeResult[]> {
    const results: ReplicaPurgeResult[] = [];
    for (const campaignId of this.store.campaignIds()) {
      results.push(await this.purge(campaignId, 'signed_out'));
    }
    this.store.deleteMembership();
    this.status.setPendingCount(0);
    this.status.setConnected(false);
    return results;
  }
}

function timestamp(value: Date): string {
  return value.toISOString().replace(/\.\d{3}Z$/, 'Z');
}
