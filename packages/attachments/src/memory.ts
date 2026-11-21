import type {
  AttachmentRecord,
  AttachmentRepository,
  AttachmentRetentionRepository,
  NewPendingAttachment,
} from './application.ts';
import type { AttachmentOwnerRef } from './model.ts';
import {
  ABANDONED_METADATA_DAYS,
  DELETED_RETENTION_DAYS,
  PENDING_LIFETIME_HOURS,
} from './policy.ts';
import {
  assertGrantLifetime,
  type ObjectListPage,
  type ObjectStorage,
  ObjectStorageUnavailable,
  type ReadGrantRequest,
  type StorageGrant,
  type StoredObject,
  type UploadGrantRequest,
} from './storage.ts';

/**
 * In-memory test kit (unit tests and API module tests). Same contracts as the PostgreSQL
 * repository and the S3 adapter; the integration tests prove the real ones.
 */

type MutableRecord = { -readonly [K in keyof AttachmentRecord]: AttachmentRecord[K] };

export class MemoryAttachmentRepository
  implements AttachmentRepository, AttachmentRetentionRepository
{
  readonly rows = new Map<string, MutableRecord>();

  constructor(public now: () => Date = () => new Date()) {}

  async insertPending(input: NewPendingAttachment): Promise<AttachmentRecord> {
    if (this.rows.has(input.id)) throw new Error('duplicate_attachment');
    const at = this.now();
    const row: MutableRecord = {
      ...input,
      verifiedSize: undefined,
      verifiedChecksum: undefined,
      status: 'pending',
      version: 1,
      createdAt: at,
      updatedAt: at,
      updatedBy: input.createdBy,
      finalizedAt: undefined,
      failedAt: undefined,
      deletedAt: undefined,
      purgeAfter: undefined,
      pendingExpired: false,
    };
    this.rows.set(row.id, row);
    return this.#view(row);
  }

  async find(campaignId: string, attachmentId: string) {
    const row = this.rows.get(attachmentId);
    return row === undefined || row.campaignId !== campaignId ? undefined : this.#view(row);
  }

  async countActivePending(campaignId: string, userId: string) {
    return [...this.rows.values()].filter(
      (row) =>
        row.campaignId === campaignId &&
        row.createdBy === userId &&
        row.status === 'pending' &&
        !this.#olderThan(row, PENDING_LIFETIME_HOURS * 3_600_000),
    ).length;
  }

  async markReady(
    campaignId: string,
    attachmentId: string,
    verified: { readonly size: number; readonly checksum: string; readonly actorUserId: string },
  ) {
    const row = this.rows.get(attachmentId);
    if (
      row === undefined ||
      row.campaignId !== campaignId ||
      row.status !== 'pending' ||
      row.deletedAt !== undefined ||
      this.#olderThan(row, PENDING_LIFETIME_HOURS * 3_600_000) ||
      verified.size !== row.declaredSize ||
      verified.checksum !== row.declaredChecksum
    ) {
      return undefined;
    }
    const at = this.now();
    Object.assign(row, {
      status: 'ready',
      verifiedSize: verified.size,
      verifiedChecksum: verified.checksum,
      finalizedAt: at,
      updatedAt: at,
      updatedBy: verified.actorUserId,
    });
    return this.#view(row);
  }

  async markFailed(campaignId: string, attachmentId: string) {
    const row = this.rows.get(attachmentId);
    if (row === undefined || row.campaignId !== campaignId || row.status !== 'pending')
      return false;
    const at = this.now();
    Object.assign(row, { status: 'failed', failedAt: at, updatedAt: at });
    return true;
  }

  async listReady(campaignId: string, owner: AttachmentOwnerRef) {
    return [...this.rows.values()]
      .filter(
        (row) =>
          row.campaignId === campaignId &&
          row.ownerResourceClass === owner.resourceClass &&
          row.ownerResourceId === owner.resourceId &&
          row.status === 'ready' &&
          row.deletedAt === undefined,
      )
      .sort(
        (left, right) =>
          left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id),
      )
      .map((row) => this.#view(row));
  }

  async expiredPending(limit: number) {
    return [...this.rows.values()]
      .filter(
        (row) =>
          row.status === 'pending' && this.#olderThan(row, PENDING_LIFETIME_HOURS * 3_600_000),
      )
      .slice(0, limit)
      .map((row) => this.#view(row));
  }

  async abandoned(limit: number) {
    return [...this.rows.values()]
      .filter(
        (row) =>
          row.status !== 'ready' &&
          row.deletedAt === undefined &&
          this.#olderThan(row, ABANDONED_METADATA_DAYS * 86_400_000),
      )
      .slice(0, limit)
      .map((row) => this.#view(row));
  }

  async hardDeleteUnready(attachmentId: string) {
    const row = this.rows.get(attachmentId);
    if (row === undefined || row.status === 'ready') return false;
    return this.rows.delete(attachmentId);
  }

  async listReadyInCampaign(campaignId: string) {
    return this.#live()
      .filter((row) => row.campaignId === campaignId)
      .sort(
        (left, right) =>
          left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id),
      )
      .map((row) => this.#view(row));
  }

  async markDeleted(
    campaignId: string,
    attachmentId: string,
    input: { readonly expectedVersion: number; readonly actorUserId: string },
  ) {
    const row = this.rows.get(attachmentId);
    if (
      row === undefined ||
      row.campaignId !== campaignId ||
      row.status !== 'ready' ||
      row.deletedAt !== undefined ||
      row.version !== input.expectedVersion
    ) {
      return undefined;
    }
    this.#tombstoneRow(row);
    row.updatedBy = input.actorUserId;
    return this.#view(row);
  }

  async campaignsWithLiveAttachments(limit: number) {
    return [...new Set(this.#live().map((row) => row.campaignId))].sort().slice(0, limit);
  }

  async tombstoneCampaign(campaignId: string) {
    const rows = this.#live().filter((row) => row.campaignId === campaignId);
    for (const row of rows) this.#tombstoneRow(row);
    return rows.length;
  }

  async purgeDue(limit: number) {
    return [...this.rows.values()]
      .filter((row) => this.#due(row))
      .sort((left, right) => (left.purgeAfter?.getTime() ?? 0) - (right.purgeAfter?.getTime() ?? 0))
      .slice(0, limit)
      .map((row) => this.#view(row));
  }

  async hardDeleteTombstone(attachmentId: string) {
    const row = this.rows.get(attachmentId);
    if (row === undefined || !this.#due(row)) return false;
    return this.rows.delete(attachmentId);
  }

  async knownObjectKeys(keys: readonly string[]) {
    const known = new Set([...this.rows.values()].map((row) => row.objectKey));
    return new Set(keys.filter((key) => known.has(key)));
  }

  async readyLive(limit: number, afterId?: string) {
    return this.#live()
      .filter((row) => afterId === undefined || row.id > afterId)
      .sort((left, right) => left.id.localeCompare(right.id))
      .slice(0, limit)
      .map((row) => this.#view(row));
  }

  /** Test helper: tombstones a ready row exactly as `markDeleted` does, without a version check. */
  tombstone(attachmentId: string): void {
    const row = this.rows.get(attachmentId);
    if (row !== undefined) this.#tombstoneRow(row);
  }

  #live(): MutableRecord[] {
    return [...this.rows.values()].filter(
      (row) => row.status === 'ready' && row.deletedAt === undefined,
    );
  }

  #tombstoneRow(row: MutableRecord): void {
    const at = this.now();
    Object.assign(row, {
      deletedAt: at,
      purgeAfter: new Date(at.getTime() + DELETED_RETENTION_DAYS * 86_400_000),
      version: row.version + 1,
      updatedAt: at,
    });
  }

  /** Exclusive, like the database: due only strictly after the deadline. */
  #due(row: MutableRecord): boolean {
    return (
      row.deletedAt !== undefined &&
      row.purgeAfter !== undefined &&
      row.purgeAfter.getTime() < this.now().getTime()
    );
  }

  /** Test helper: replaces the Visibility of a row. */
  setVisibility(attachmentId: string, visibility: AttachmentRecord['visibility']): void {
    const row = this.rows.get(attachmentId);
    if (row !== undefined) row.visibility = visibility;
  }

  #olderThan(row: MutableRecord, ms: number): boolean {
    return row.createdAt.getTime() + ms < this.now().getTime();
  }

  #view(row: MutableRecord): AttachmentRecord {
    return {
      ...row,
      pendingExpired:
        row.status === 'pending' && this.#olderThan(row, PENDING_LIFETIME_HOURS * 3_600_000),
    };
  }
}

/** Grants are `memory://` URLs; `put` simulates the client's direct upload. */
export class MemoryObjectStorage implements ObjectStorage {
  readonly objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  readonly grants: StorageGrant[] = [];
  readonly deleted: string[] = [];
  /** Operations that throw `ObjectStorageUnavailable` until cleared. */
  readonly failing = new Set<'upload' | 'read_grant' | 'inspect' | 'read' | 'delete' | 'list'>();

  constructor(public now: () => Date = () => new Date()) {}

  put(key: string, bytes: Uint8Array, contentType = 'application/octet-stream'): void {
    this.objects.set(key, { bytes, contentType });
  }

  async createUploadGrant(request: UploadGrantRequest): Promise<StorageGrant> {
    this.#fail('upload');
    assertGrantLifetime(request.expiresInSeconds);
    return this.#grant('PUT', request.key, request.expiresInSeconds, {
      'content-type': request.contentType,
    });
  }

  async createReadGrant(request: ReadGrantRequest): Promise<StorageGrant> {
    this.#fail('read_grant');
    assertGrantLifetime(request.expiresInSeconds);
    return this.#grant('GET', request.key, request.expiresInSeconds, {});
  }

  async inspect(key: string): Promise<StoredObject | undefined> {
    this.#fail('inspect');
    const object = this.objects.get(key);
    return object === undefined ? undefined : { size: object.bytes.byteLength };
  }

  async *read(key: string): AsyncIterable<Uint8Array> {
    this.#fail('read');
    const object = this.objects.get(key);
    if (object === undefined) throw new ObjectStorageUnavailable('read');
    // Odd-sized chunks exercise the streamed digest.
    for (let offset = 0; offset < object.bytes.byteLength; offset += 7) {
      yield object.bytes.subarray(offset, offset + 7);
    }
  }

  async delete(key: string): Promise<void> {
    this.#fail('delete');
    this.objects.delete(key);
    this.deleted.push(key);
  }

  async list(request: {
    readonly prefix: string;
    readonly after?: string;
    readonly limit: number;
  }) {
    this.#fail('list');
    const keys = [...this.objects.keys()]
      .filter((key) => key.startsWith(request.prefix))
      .filter((key) => request.after === undefined || key > request.after)
      .sort();
    const page: ObjectListPage = { keys: keys.slice(0, request.limit) };
    return keys.length > request.limit ? { ...page, after: page.keys.at(-1) } : page;
  }

  #grant(
    method: 'PUT' | 'GET',
    key: string,
    seconds: number,
    headers: Record<string, string>,
  ): StorageGrant {
    const grant = {
      method,
      url: `memory://${method.toLowerCase()}/${encodeURIComponent(key)}?n=${this.grants.length}`,
      headers,
      expiresAt: new Date(this.now().getTime() + seconds * 1000),
    };
    this.grants.push(grant);
    return grant;
  }

  #fail(operation: 'upload' | 'read_grant' | 'inspect' | 'read' | 'delete' | 'list'): void {
    if (this.failing.has(operation)) throw new ObjectStorageUnavailable(operation);
  }
}
