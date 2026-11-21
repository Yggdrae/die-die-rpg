import type { ActorRef, ReplicaPurged, ReplicaPurgeReason } from '@rpg/contracts';
import type { CachedMembership, MembershipReconcile } from './model.ts';

type MaybePromise<T> = T | Promise<T>;

export interface ReplicaPurgeResult {
  readonly event: ReplicaPurged;
  /** Listener failures never undo the purge; each listener must be idempotent and retry itself. */
  readonly listenerErrors: readonly unknown[];
}

/**
 * Local membership cache the reconciler needs. `SqliteReplicaStore` (Bun) answers synchronously;
 * the browser store (`@rpg/sync/browser`) answers through the SQLite worker.
 */
export interface ReplicaAccessStore {
  cachedMembership(campaignId: string): MaybePromise<CachedMembership | undefined>;
  cachedMemberships(): MaybePromise<readonly CachedMembership[]>;
  putMembership(row: CachedMembership): MaybePromise<void>;
  hasPendingCreation(campaignId: string): MaybePromise<boolean>;
}

/** Destroys one campaign replica (`ReplicaManager`, or the browser replica manager). */
export interface ReplicaPurger {
  purge(campaignId: string, reason: ReplicaPurgeReason): Promise<ReplicaPurgeResult>;
}

export interface MembershipApplyReport {
  readonly replaced: readonly string[];
  readonly removed: readonly string[];
  readonly kept: readonly string[];
  /** Campaigns whose replica was destroyed (tombstone, absence, or ignored foreign row). */
  readonly purged: readonly ReplicaPurgeResult[];
}

/**
 * Device-side access reconciliation on reconnect/bootstrap (feature 03 task 07). Applies the
 * current user's membership rows with feature 01's injected rule, keeps the local cache, and
 * destroys a campaign replica when access ends. Provider-neutral: the read adapter hands it rows.
 */
export class ReplicaAccessReconciler {
  constructor(
    private readonly store: ReplicaAccessStore,
    private readonly replicas: ReplicaPurger,
    private readonly reconcile: MembershipReconcile,
  ) {}

  /**
   * `complete: true` means `rows` is the authority's whole current-user set (initial or resumed
   * bootstrap). Then a campaign whose cached membership is active but absent from `rows` lost
   * access and is purged. Campaigns never confirmed by the authority (offline creation without a
   * cached membership) are not touched by absence.
   */
  async applyMemberships(
    userId: string,
    rows: readonly CachedMembership[],
    options: { readonly complete: boolean },
  ): Promise<MembershipApplyReport> {
    const replaced: string[] = [];
    const removed: string[] = [];
    const kept: string[] = [];
    const purged: ReplicaPurgeResult[] = [];
    const seen = new Set<string>();
    for (const incoming of rows) {
      // The stream is current-user only; a foreign row is a provider fault and never cached.
      if (incoming.userId !== userId) continue;
      seen.add(incoming.campaignId);
      const decision = this.reconcile(
        await this.store.cachedMembership(incoming.campaignId),
        incoming,
      );
      if (decision === 'keep') {
        kept.push(incoming.campaignId);
        continue;
      }
      await this.store.putMembership(incoming);
      if (decision === 'replace') {
        replaced.push(incoming.campaignId);
        continue;
      }
      removed.push(incoming.campaignId);
      purged.push(await this.replicas.purge(incoming.campaignId, 'access_revoked'));
    }
    if (options.complete) {
      for (const cached of await this.store.cachedMemberships()) {
        if (seen.has(cached.campaignId) || cached.removedAt !== null) continue;
        removed.push(cached.campaignId);
        // Local tombstone at the cached version: only a higher authority version restores access.
        await this.store.putMembership({ ...cached, removedAt: cached.updatedAt });
        purged.push(await this.replicas.purge(cached.campaignId, 'access_revoked'));
      }
    }
    return { replaced, removed, kept, purged };
  }

  /**
   * Bootstrap answered "not found or forbidden". A campaign with a queued, not yet accepted
   * creation is kept (the authority has not seen it); anything else loses its replica.
   */
  async accessDenied(campaignId: string): Promise<ReplicaPurgeResult | undefined> {
    const cached = await this.store.cachedMembership(campaignId);
    if (cached === undefined && (await this.store.hasPendingCreation(campaignId))) return undefined;
    return this.replicas.purge(campaignId, 'access_revoked');
  }

  /**
   * Authority confirmed the campaign is deleted (server tombstone row, or acceptance of the local
   * tombstone mutation). Never call it for an unconfirmed local delete: its mutation must upload.
   */
  campaignDeleted(campaignId: string): Promise<ReplicaPurgeResult> {
    return this.replicas.purge(campaignId, 'campaign_deleted');
  }

  /**
   * Offline actor resolution from a synchronous cache (`SqliteReplicaStore`). An asynchronous
   * store resolves with `cachedActor(userId, campaignId, await store.cachedMembership(...))`.
   */
  actor(userId: string, campaignId: string): ActorRef | undefined {
    const cached = this.store.cachedMembership(campaignId);
    if (cached instanceof Promise) throw new Error('asynchronous membership cache');
    return cachedActor(userId, campaignId, cached);
  }
}

/** A tombstone, a foreign row, or a missing row resolves no actor. */
export function cachedActor(
  userId: string,
  campaignId: string,
  cached: CachedMembership | undefined,
): ActorRef | undefined {
  if (cached === undefined || cached.userId !== userId || cached.removedAt !== null) {
    return undefined;
  }
  return { userId, campaignId, role: cached.role };
}
