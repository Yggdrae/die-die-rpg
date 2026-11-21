import type { ReplicaPurged, ReplicaPurgeListener } from '@rpg/contracts';
import type { AttachmentMetadata, AttachmentOwnerRef } from './model.ts';

/**
 * Device-local attachment availability (`_db.md`, Local Offline Schema and Bytes; `_bdd.md`,
 * Offline Availability). Browser-safe: no Bun or Node API (entry `@rpg/attachments/offline`). Two ports:
 *
 * - `OfflineAttachmentDb`: this device's per-user record + byte store. A record and its bytes
 *   change in one atomic step, so a verified download is never half-visible and a purge never
 *   leaves bytes behind. The browser adapter is IndexedDB (`apps/web/src/features/attachments/offline-db.ts`).
 * - `OfflineAttachmentSource`: the authorized network path (offline set from the API, a fresh
 *   five-minute read grant per download, the bytes from the storage origin).
 *
 * Metadata does not replicate through feature 03 (no provable PowerSync rule for a per-record
 * owner, `docs/OFFLINE_SYNC_RUNTIME.md`), so the device keeps the metadata of the attachments it
 * knows next to their bytes, only for attachments an authorization decision returned, and drops
 * both on the removal signals: a feature 03 replica purge (revocation, campaign deletion,
 * sign-out) through `ReplicaPurgeListener`, an offline set that no longer lists an attachment
 * (visibility narrowing, deletion), and a read check that is denied.
 *
 * Nothing downloads without `pin(plan)` (the user's confirmation of `plan()`'s estimate).
 */

/** Stored state. `unavailable` is derived: no local bytes and no network. */
export type StoredAvailability = 'cloud_only' | 'cached' | 'pinned' | 'downloading';
export type AvailabilityState = StoredAvailability | 'unavailable';

export interface LocalAttachment {
  readonly attachmentId: string;
  readonly campaignId: string;
  readonly owner: AttachmentOwnerRef;
  readonly filename: string;
  readonly mime: AttachmentMetadata['mime'];
  readonly size: number;
  /** Lowercase hex SHA-256 the authority verified at finalization. */
  readonly checksum: string;
  readonly version: number;
  readonly state: StoredAvailability;
  readonly downloadedBytes: number;
  /** Explicit offline intent (campaign pin); survives restart and interruption. */
  readonly pinRequestedAt?: string;
  /** Cache eviction order only. */
  readonly lastAccessedAt?: string;
}

export interface OfflineAttachmentDb {
  get(attachmentId: string): Promise<LocalAttachment | undefined>;
  list(campaignId: string): Promise<LocalAttachment[]>;
  all(): Promise<LocalAttachment[]>;
  /**
   * Writes the record and, atomically with it: `bytes` replaces the stored bytes, `null` deletes
   * them, `undefined` leaves them as they are.
   */
  put(record: LocalAttachment, bytes?: Uint8Array | null): Promise<void>;
  bytes(attachmentId: string): Promise<Uint8Array | undefined>;
  /** Records and their bytes, atomically. */
  remove(attachmentIds: readonly string[]): Promise<void>;
  clear(): Promise<void>;
}

export type OfflineSetResult =
  | { readonly kind: 'ok'; readonly items: readonly AttachmentMetadata[] }
  /** The authority answered "not found or forbidden": no campaign access any more. */
  | { readonly kind: 'denied' }
  | { readonly kind: 'offline' };

export type DownloadResult =
  | { readonly kind: 'ok'; readonly bytes: Uint8Array }
  /** No read grant: hidden, deleted, or no access. */
  | { readonly kind: 'denied' }
  /** Network, provider or expiry failure; retried later. */
  | { readonly kind: 'failed' };

export type ReadCheck = 'allowed' | 'denied' | 'offline';

export interface OfflineAttachmentSource {
  offlineSet(campaignId: string): Promise<OfflineSetResult>;
  download(
    campaignId: string,
    attachmentId: string,
    options: { readonly signal: AbortSignal; readonly onProgress: (bytes: number) => void },
  ): Promise<DownloadResult>;
  /** Fresh authorization for one attachment (the read route); never cached. */
  check(campaignId: string, attachmentId: string): Promise<ReadCheck>;
}

/** What confirming `pin` would download. Shown to the user before anything downloads. */
export interface PinPlan {
  readonly campaignId: string;
  readonly items: readonly AttachmentMetadata[];
  /** Visible attachments without matching local bytes. */
  readonly download: readonly AttachmentMetadata[];
  /** Exact payload bytes of `download` (protocol overhead excluded). */
  readonly estimatedBytes: number;
  /** Already present with a matching checksum: no second copy is made. */
  readonly alreadyLocal: number;
}

export type PlanResult =
  | { readonly kind: 'ok'; readonly plan: PinPlan }
  | { readonly kind: 'denied' }
  | { readonly kind: 'offline' };

export interface PinProgress {
  readonly campaignId: string;
  readonly total: number;
  readonly completed: number;
  readonly failed: number;
  readonly downloading: readonly string[];
  readonly totalBytes: number;
  readonly downloadedBytes: number;
  /** Verified payload bytes actually stored by this pin (estimate accuracy). */
  readonly storedBytes: number;
  readonly done: boolean;
}

export type LocalOpen =
  | {
      readonly kind: 'local';
      readonly attachment: LocalAttachment;
      readonly bytes: Uint8Array;
      readonly availability: 'cached' | 'pinned';
    }
  | { readonly kind: 'unavailable' };

export interface OfflineAttachmentStoreOptions {
  readonly db: OfflineAttachmentDb;
  readonly source: OfflineAttachmentSource;
  /** Browser network state; defaults to `navigator.onLine`. */
  readonly online?: () => boolean;
  /** Parallel downloads. Default 3. */
  readonly concurrency?: number;
  readonly now?: () => Date;
}

/** Estimate tolerance (`_db.md`): max(1 MiB, 1%) of the payload bytes. */
export function estimateTolerance(estimatedBytes: number): number {
  return Math.max(1_048_576, Math.ceil(estimatedBytes * 0.01));
}

export async function sha256HexOf(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', copy.buffer));
  return [...digest].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function hasBytes(record: LocalAttachment): boolean {
  return record.state === 'cached' || record.state === 'pinned';
}

export class OfflineAttachmentStore implements ReplicaPurgeListener {
  readonly #db: OfflineAttachmentDb;
  readonly #source: OfflineAttachmentSource;
  readonly #online: () => boolean;
  readonly #concurrency: number;
  readonly #now: () => Date;
  /** In-flight downloads by attachment, so a purge can abort them. */
  readonly #active = new Map<string, { campaignId: string; controller: AbortController }>();
  /** Bumped by every purge of a campaign: a download that started before never writes. */
  readonly #generation = new Map<string, number>();
  readonly #listeners = new Set<() => void>();

  constructor(options: OfflineAttachmentStoreOptions) {
    this.#db = options.db;
    this.#source = options.source;
    this.#online =
      options.online ??
      (() => (globalThis.navigator as { onLine?: boolean } | undefined)?.onLine ?? true);
    this.#concurrency = Math.max(1, options.concurrency ?? 3);
    this.#now = options.now ?? (() => new Date());
  }

  /** Change notifications for views (state, progress, purge). Returns an unsubscriber. */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * After a restart: a download that was interrupted left no bytes (bytes are written only once
   * verified), so its record returns to cloud only with its pin intent kept for `resume`.
   */
  async start(): Promise<void> {
    for (const record of await this.#db.all()) {
      if (record.state === 'downloading' && !this.#active.has(record.attachmentId)) {
        await this.#db.put({ ...record, state: 'cloud_only', downloadedBytes: 0 }, null);
      }
    }
  }

  availability(record: LocalAttachment): AvailabilityState {
    if (this.#active.has(record.attachmentId)) return 'downloading';
    if (hasBytes(record)) return record.state;
    return this.#online() ? 'cloud_only' : 'unavailable';
  }

  async list(
    campaignId: string,
  ): Promise<(LocalAttachment & { readonly availability: AvailabilityState })[]> {
    const records = await this.#db.list(campaignId);
    return records
      .sort((left, right) => left.filename.localeCompare(right.filename))
      .map((record) => ({ ...record, availability: this.availability(record) }));
  }

  /** Local payload bytes by retention (`_bdd.md` P1 storage usage; also the pin cost check). */
  async usage(campaignId: string): Promise<{ readonly pinned: number; readonly cached: number }> {
    let pinned = 0;
    let cached = 0;
    for (const record of await this.#db.list(campaignId)) {
      if (record.state === 'pinned') pinned += record.size;
      if (record.state === 'cached') cached += record.size;
    }
    return { pinned, cached };
  }

  /**
   * The estimate shown before confirmation. Reads the authorized offline set (which also
   * reconciles anything this device holds for the campaign) and downloads nothing.
   */
  async plan(campaignId: string): Promise<PlanResult> {
    const set = await this.#source.offlineSet(campaignId);
    if (set.kind === 'denied') {
      await this.purgeCampaign(campaignId);
      return set;
    }
    if (set.kind === 'offline') return set;
    await this.#apply(campaignId, set.items);
    const download: AttachmentMetadata[] = [];
    let alreadyLocal = 0;
    for (const item of set.items) {
      const local = await this.#db.get(item.attachmentId);
      if (local !== undefined && hasBytes(local) && local.checksum === item.checksum) {
        alreadyLocal += 1;
      } else {
        download.push(item);
      }
    }
    return {
      kind: 'ok',
      plan: {
        campaignId,
        items: set.items,
        download,
        estimatedBytes: download.reduce((sum, item) => sum + item.size, 0),
        alreadyLocal,
      },
    };
  }

  /**
   * The user confirmed `plan`: record the pin intent for every planned attachment, promote
   * matching local bytes to pinned (no second copy), and download the rest with bounded
   * concurrency. Each download is verified (size, SHA-256) before it is stored.
   */
  async pin(plan: PinPlan, onProgress?: (progress: PinProgress) => void): Promise<PinProgress> {
    const at = this.#now().toISOString();
    for (const item of plan.items) {
      const local = await this.#db.get(item.attachmentId);
      const base = local ?? fromMetadata(item);
      await this.#db.put({
        ...base,
        ...metadataFields(item),
        pinRequestedAt: base.pinRequestedAt ?? at,
        ...(local !== undefined && hasBytes(local) && local.checksum === item.checksum
          ? { state: 'pinned' as const }
          : {}),
      });
    }
    this.#notify();
    return this.#download(plan.campaignId, plan.download, plan.estimatedBytes, onProgress);
  }

  /** Re-downloads every pinned-but-missing attachment of the campaign (after interruption). */
  async resume(
    campaignId: string,
    onProgress?: (progress: PinProgress) => void,
  ): Promise<PinProgress> {
    const missing = (await this.#db.list(campaignId)).filter(
      (record) =>
        record.pinRequestedAt !== undefined &&
        !hasBytes(record) &&
        !this.#active.has(record.attachmentId),
    );
    const items = missing.map(toMetadataLike);
    return this.#download(
      campaignId,
      items,
      items.reduce((sum, item) => sum + item.size, 0),
      onProgress,
    );
  }

  /** Evictable copy of one attachment the Actor opened (cached, never pinned by this). */
  async cache(item: AttachmentMetadata): Promise<'cached' | 'pinned' | 'denied' | 'failed'> {
    const local = await this.#db.get(item.attachmentId);
    if (local !== undefined && hasBytes(local) && local.checksum === item.checksum) {
      await this.#db.put({ ...local, lastAccessedAt: this.#now().toISOString() });
      return local.state === 'pinned' ? 'pinned' : 'cached';
    }
    await this.#db.put({ ...(local ?? fromMetadata(item)), ...metadataFields(item) });
    const outcome = await this.#fetchOne(item.campaignId, item, 'cached', () => undefined);
    return outcome === 'stored' ? 'cached' : outcome === 'denied' ? 'denied' : 'failed';
  }

  /** Drops least recently used cached bytes until cached usage fits `budgetBytes`. */
  async evict(budgetBytes: number): Promise<number> {
    const cached = (await this.#db.all())
      .filter((record) => record.state === 'cached')
      .sort((left, right) => (left.lastAccessedAt ?? '').localeCompare(right.lastAccessedAt ?? ''));
    let total = cached.reduce((sum, record) => sum + record.size, 0);
    let evicted = 0;
    for (const record of cached) {
      if (total <= budgetBytes) break;
      await this.#db.put({ ...record, state: 'cloud_only', downloadedBytes: 0 }, null);
      total -= record.size;
      evicted += 1;
    }
    if (evicted > 0) this.#notify();
    return evicted;
  }

  /**
   * Opens local content. Online, a fresh read decision comes first and a denial purges the
   * attachment; offline, the stored copy is used (a disconnected device cannot learn of a
   * revocation, `_db.md`). Bytes are re-verified against the authority's checksum.
   */
  async openLocal(attachmentId: string): Promise<LocalOpen> {
    const record = await this.#db.get(attachmentId);
    if (record === undefined || !hasBytes(record)) return { kind: 'unavailable' };
    if (this.#online()) {
      const check = await this.#source.check(record.campaignId, attachmentId);
      if (check === 'denied') {
        await this.#db.remove([attachmentId]);
        this.#notify();
        return { kind: 'unavailable' };
      }
    }
    const bytes = await this.#db.bytes(attachmentId);
    if (
      bytes === undefined ||
      bytes.byteLength !== record.size ||
      (await sha256HexOf(bytes)) !== record.checksum
    ) {
      await this.#db.put({ ...record, state: 'cloud_only', downloadedBytes: 0 }, null);
      this.#notify();
      return { kind: 'unavailable' };
    }
    const touched = { ...record, lastAccessedAt: this.#now().toISOString() };
    await this.#db.put(touched);
    return {
      kind: 'local',
      attachment: touched,
      bytes,
      availability: record.state === 'pinned' ? 'pinned' : 'cached',
    };
  }

  /**
   * Observed synchronization: the authority's current offline set for a campaign this device
   * holds anything for. Absent attachments (narrowed, deleted) lose metadata and bytes; a denied
   * campaign is purged; new visible attachments become known as cloud only. Offline: no change.
   */
  async reconcile(campaignId: string): Promise<'reconciled' | 'purged' | 'offline'> {
    if ((await this.#db.list(campaignId)).length === 0) return 'reconciled';
    const set = await this.#source.offlineSet(campaignId);
    if (set.kind === 'offline') return 'offline';
    if (set.kind === 'denied') {
      await this.purgeCampaign(campaignId);
      return 'purged';
    }
    await this.#apply(campaignId, set.items, true);
    return 'reconciled';
  }

  async reconcileAll(): Promise<void> {
    const campaigns = new Set((await this.#db.all()).map((record) => record.campaignId));
    for (const campaignId of campaigns) await this.reconcile(campaignId);
  }

  /** Aborts downloads, then removes every record and byte of the campaign. Idempotent. */
  async purgeCampaign(campaignId: string): Promise<void> {
    this.#generation.set(campaignId, (this.#generation.get(campaignId) ?? 0) + 1);
    for (const [attachmentId, active] of this.#active) {
      if (active.campaignId !== campaignId) continue;
      active.controller.abort();
      this.#active.delete(attachmentId);
    }
    const records = await this.#db.list(campaignId);
    await this.#db.remove(records.map((record) => record.attachmentId));
    this.#notify();
  }

  /** Feature 03 removal signal (revocation, campaign deletion, sign-out). */
  async replicaPurged(event: ReplicaPurged): Promise<void> {
    await this.purgeCampaign(event.campaignId);
  }

  /** Sign-out: every attachment byte and record leaves the device. */
  async clear(): Promise<void> {
    const campaigns = new Set([...this.#active.values()].map((active) => active.campaignId));
    for (const record of await this.#db.all()) campaigns.add(record.campaignId);
    for (const campaignId of campaigns) await this.purgeCampaign(campaignId);
    await this.#db.clear();
    this.#notify();
  }

  /** Removes local entries the authority no longer lists; refreshes metadata of the rest. */
  async #apply(
    campaignId: string,
    items: readonly AttachmentMetadata[],
    addNew = false,
  ): Promise<void> {
    const visible = new Map(items.map((item) => [item.attachmentId, item]));
    const local = await this.#db.list(campaignId);
    const gone = local.filter(
      (record) => visible.get(record.attachmentId)?.checksum !== record.checksum,
    );
    for (const record of gone) {
      this.#active.get(record.attachmentId)?.controller.abort();
      this.#active.delete(record.attachmentId);
    }
    if (gone.length > 0) await this.#db.remove(gone.map((record) => record.attachmentId));
    const goneIds = new Set(gone.map((record) => record.attachmentId));
    const known = new Set(local.map((record) => record.attachmentId));
    for (const item of items) {
      if (known.has(item.attachmentId) && !goneIds.has(item.attachmentId)) {
        const current = await this.#db.get(item.attachmentId);
        if (current !== undefined) await this.#db.put({ ...current, ...metadataFields(item) });
      } else if (addNew && !known.has(item.attachmentId)) {
        await this.#db.put(fromMetadata(item));
      }
    }
    this.#notify();
  }

  async #download(
    campaignId: string,
    items: readonly Pick<AttachmentMetadata, 'attachmentId' | 'size' | 'checksum'>[],
    totalBytes: number,
    onProgress?: (progress: PinProgress) => void,
  ): Promise<PinProgress> {
    const received = new Map<string, number>();
    let completed = 0;
    let failed = 0;
    let storedBytes = 0;
    const snapshot = (done: boolean): PinProgress => ({
      campaignId,
      total: items.length,
      completed,
      failed,
      downloading: [...received.keys()].filter((id) => this.#active.has(id)),
      totalBytes,
      downloadedBytes: [...received.values()].reduce((sum, value) => sum + value, 0),
      storedBytes,
      done,
    });
    const queue = [...items];
    const worker = async () => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
        const current = item;
        received.set(current.attachmentId, 0);
        onProgress?.(snapshot(false));
        const outcome = await this.#fetchOne(campaignId, current, 'pinned', (bytes) => {
          received.set(current.attachmentId, bytes);
          onProgress?.(snapshot(false));
        });
        if (outcome === 'stored') {
          completed += 1;
          storedBytes += current.size;
          received.set(current.attachmentId, current.size);
        } else {
          failed += 1;
          received.set(current.attachmentId, 0);
        }
        onProgress?.(snapshot(false));
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(this.#concurrency, items.length) }, () => worker()),
    );
    const final = snapshot(true);
    onProgress?.(final);
    this.#notify();
    return final;
  }

  /** One authorized, verified download into `state`. Never writes after a purge or removal. */
  async #fetchOne(
    campaignId: string,
    item: Pick<AttachmentMetadata, 'attachmentId' | 'size' | 'checksum'>,
    state: 'cached' | 'pinned',
    onProgress: (bytes: number) => void,
  ): Promise<'stored' | 'denied' | 'failed'> {
    const generation = this.#generation.get(campaignId) ?? 0;
    const current = () => (this.#generation.get(campaignId) ?? 0) === generation;
    const record = await this.#db.get(item.attachmentId);
    if (record === undefined || this.#active.has(item.attachmentId)) return 'failed';
    const controller = new AbortController();
    this.#active.set(item.attachmentId, { campaignId, controller });
    await this.#db.put({ ...record, state: 'downloading', downloadedBytes: 0 }, null);
    this.#notify();
    let result: DownloadResult;
    try {
      result = await this.#source.download(campaignId, item.attachmentId, {
        signal: controller.signal,
        onProgress,
      });
    } catch {
      result = { kind: 'failed' };
    }
    const aborted = controller.signal.aborted;
    if (this.#active.get(item.attachmentId)?.controller === controller) {
      this.#active.delete(item.attachmentId);
    }
    const latest = await this.#db.get(item.attachmentId);
    if (aborted || !current() || latest === undefined) return 'failed';
    if (result.kind === 'denied') {
      // No longer visible: neither its metadata nor its bytes stay on the device.
      await this.#db.remove([item.attachmentId]);
      this.#notify();
      return 'denied';
    }
    if (
      result.kind === 'ok' &&
      result.bytes.byteLength === item.size &&
      (await sha256HexOf(result.bytes)) === item.checksum &&
      current()
    ) {
      await this.#db.put(
        {
          ...latest,
          state,
          downloadedBytes: item.size,
          lastAccessedAt: this.#now().toISOString(),
        },
        result.bytes,
      );
      this.#notify();
      return 'stored';
    }
    // Failed or corrupted: nothing partial is kept; a pin intent stays for `resume`.
    await this.#db.put({ ...latest, state: 'cloud_only', downloadedBytes: 0 }, null);
    this.#notify();
    return 'failed';
  }

  #notify(): void {
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch {
        // A view's failure never affects the store.
      }
    }
  }
}

function metadataFields(item: AttachmentMetadata) {
  return {
    campaignId: item.campaignId,
    owner: item.owner,
    filename: item.filename,
    mime: item.mime,
    size: item.size,
    checksum: item.checksum,
    version: item.version,
  };
}

function fromMetadata(item: AttachmentMetadata): LocalAttachment {
  return {
    attachmentId: item.attachmentId,
    ...metadataFields(item),
    state: 'cloud_only',
    downloadedBytes: 0,
  };
}

function toMetadataLike(record: LocalAttachment) {
  return { attachmentId: record.attachmentId, size: record.size, checksum: record.checksum };
}

/** In-memory `OfflineAttachmentDb` (tests and environments without IndexedDB). */
export class MemoryOfflineAttachmentDb implements OfflineAttachmentDb {
  readonly records = new Map<string, LocalAttachment>();
  readonly blobs = new Map<string, Uint8Array>();

  async get(attachmentId: string) {
    return this.records.get(attachmentId);
  }

  async list(campaignId: string) {
    return [...this.records.values()].filter((record) => record.campaignId === campaignId);
  }

  async all() {
    return [...this.records.values()];
  }

  async put(record: LocalAttachment, bytes?: Uint8Array | null) {
    this.records.set(record.attachmentId, record);
    if (bytes === null) this.blobs.delete(record.attachmentId);
    else if (bytes !== undefined) this.blobs.set(record.attachmentId, bytes.slice());
  }

  async bytes(attachmentId: string) {
    return this.blobs.get(attachmentId)?.slice();
  }

  async remove(attachmentIds: readonly string[]) {
    for (const id of attachmentIds) {
      this.records.delete(id);
      this.blobs.delete(id);
    }
  }

  async clear() {
    this.records.clear();
    this.blobs.clear();
  }
}
