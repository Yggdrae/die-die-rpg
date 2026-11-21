import { type CampaignAuditSubmission, deriveAuditEventId } from '@rpg/audit';
import {
  type Capability,
  MAX_VISIBILITY_TARGETS,
  normalizeVisibility,
  type ResourceFacts,
  type VisibilityActorResolver,
} from '@rpg/authorization';
import {
  type ActorRef,
  check,
  err,
  Id,
  ok,
  type Result,
  type Visibility,
  Visibility as VisibilitySchema,
} from '@rpg/contracts';
import { digestStream, matchesFileSignature, objectKeyFor } from './content.ts';
import type {
  AttachmentFinalizeRequest,
  AttachmentMetadata,
  AttachmentOwnerRef,
  AttachmentReadGrant,
  AttachmentUploadPermission,
  AttachmentUploadRequest,
} from './model.ts';
import {
  type AttachmentMimeType,
  checkFilePolicy,
  type FilePolicyViolation,
  isAllowedMime,
  PENDING_LIFETIME_HOURS,
  READ_GRANT_SECONDS,
  UPLOAD_GRANT_SECONDS,
} from './policy.ts';
import { type ObjectStorage, ObjectStorageUnavailable } from './storage.ts';

/**
 * Attachment application service: the published module API (`_prd.md` FR-013) behind the HTTP
 * routes and any consuming feature. Every operation obtains a fresh feature 04 decision for the
 * owning record before anything is written or signed; hidden and missing attachments fail the same
 * way (`not_found`).
 *
 * Effective decision for an attachment = the owner's decision for the capability AND the same
 * owner declaration evaluated with the attachment's own Visibility (an attachment can narrow its
 * owner, never widen it).
 */

export type AttachmentStatus = 'pending' | 'ready' | 'failed';

export interface AttachmentRecord {
  readonly id: string;
  readonly campaignId: string;
  readonly ownerResourceClass: string;
  readonly ownerResourceId: string;
  readonly filename: string;
  readonly mime: AttachmentMimeType;
  readonly declaredSize: number;
  readonly verifiedSize: number | undefined;
  /** Lowercase hex SHA-256. */
  readonly declaredChecksum: string;
  readonly verifiedChecksum: string | undefined;
  readonly objectKey: string;
  readonly status: AttachmentStatus;
  readonly visibility: Visibility;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly createdBy: string;
  readonly updatedBy: string;
  readonly finalizedAt: Date | undefined;
  readonly failedAt: Date | undefined;
  readonly deletedAt: Date | undefined;
  readonly purgeAfter: Date | undefined;
  /** Pending for longer than the pending lifetime, by database time (exclusive). */
  readonly pendingExpired: boolean;
}

export interface NewPendingAttachment {
  readonly id: string;
  readonly campaignId: string;
  readonly ownerResourceClass: string;
  readonly ownerResourceId: string;
  readonly filename: string;
  readonly mime: AttachmentMimeType;
  readonly declaredSize: number;
  readonly declaredChecksum: string;
  readonly objectKey: string;
  readonly visibility: Visibility;
  readonly createdBy: string;
}

/** Attachment metadata persistence. Binary content never passes through it. */
export interface AttachmentRepository {
  insertPending(input: NewPendingAttachment): Promise<AttachmentRecord>;
  /** Any status, tombstoned included; `undefined` for a missing row or another campaign. */
  find(campaignId: string, attachmentId: string): Promise<AttachmentRecord | undefined>;
  /** Unexpired pending uploads the user started in the campaign. */
  countActivePending(campaignId: string, userId: string): Promise<number>;
  /** Pending → ready, only from an unexpired pending row. `undefined` when nothing changed. */
  markReady(
    campaignId: string,
    attachmentId: string,
    verified: { readonly size: number; readonly checksum: string; readonly actorUserId: string },
  ): Promise<AttachmentRecord | undefined>;
  /** Pending → failed. `false` when the row was not pending. */
  markFailed(campaignId: string, attachmentId: string): Promise<boolean>;
  /** Ready, non-deleted attachments of one owner, oldest first. */
  listReady(campaignId: string, owner: AttachmentOwnerRef): Promise<AttachmentRecord[]>;
  /** Pending rows past the pending lifetime (database time). */
  expiredPending(limit: number): Promise<AttachmentRecord[]>;
  /** Pending or failed rows past the abandoned-metadata lifetime (database time). */
  abandoned(limit: number): Promise<AttachmentRecord[]>;
  /** Hard-deletes a never-ready row. `false` when it is ready or already gone. */
  hardDeleteUnready(attachmentId: string): Promise<boolean>;
  /** Ready, non-deleted attachments of a whole campaign, oldest first (offline set, export). */
  listReadyInCampaign(campaignId: string): Promise<AttachmentRecord[]>;
  /**
   * Ready live row at `expectedVersion` → tombstone: version + 1, `deleted_at` now, `purge_after`
   * exactly the retention window later (database time). `undefined` when nothing changed.
   */
  markDeleted(
    campaignId: string,
    attachmentId: string,
    input: { readonly expectedVersion: number; readonly actorUserId: string },
  ): Promise<AttachmentRecord | undefined>;
}

/**
 * Retention and reconciliation reads/writes (`_db.md`, Deletion and Reconciliation). Separate
 * from the request path: nothing here runs inside a user transaction.
 */
export interface AttachmentRetentionRepository {
  /** Campaigns that still have ready, non-deleted attachments. */
  campaignsWithLiveAttachments(limit: number): Promise<string[]>;
  /** Tombstones every ready live row of the campaign under the same retention rule. */
  tombstoneCampaign(campaignId: string): Promise<number>;
  /** Tombstones whose `purge_after` has passed (database time, exclusive), oldest first. */
  purgeDue(limit: number): Promise<AttachmentRecord[]>;
  /** Hard-deletes a due tombstone. `false` when the row is live, not yet due, or gone. */
  hardDeleteTombstone(attachmentId: string): Promise<boolean>;
  /** The subset of `keys` that some metadata row (any status) still names. */
  knownObjectKeys(keys: readonly string[]): Promise<Set<string>>;
  /** Ready live rows ordered by ID, after `afterId` (missing-object diagnostics). */
  readyLive(limit: number, afterId?: string): Promise<AttachmentRecord[]>;
}

export type OwnerDecision =
  | { readonly allowed: true; readonly actor: ActorRef; readonly facts: ResourceFacts }
  | { readonly allowed: false };

/** Feature 04 seam. The API adapts `ContentAccess.authorizeResource` and `AuthorizationService`. */
export interface AttachmentAuthorizer {
  /** Fresh decision on the owning record; facts always reload from the class's own source. */
  authorizeOwner(
    userId: string,
    input: {
      readonly campaignId: string;
      readonly resourceClass: string;
      readonly resourceId: string;
      readonly capability: Capability;
    },
  ): Promise<OwnerDecision>;
  /** One decision over already-loaded facts (the owner's facts with the attachment's Visibility). */
  decide(actor: ActorRef, capability: Capability, facts: ResourceFacts): boolean;
}

export interface AttachmentAuditRecorder {
  recordCampaign(submission: CampaignAuditSubmission): Promise<unknown>;
}

export interface AttachmentServiceLog {
  /** Operation name only: never a key, URL, filename or credential. */
  storageUnavailable(operation: string): void;
}

export interface AttachmentServiceDependencies {
  readonly repository: AttachmentRepository;
  readonly storage: ObjectStorage;
  readonly authorizer: AttachmentAuthorizer;
  /** Identity's `ActorResolver`, for `players` Visibility targets. */
  readonly members: VisibilityActorResolver;
  readonly audit?: AttachmentAuditRecorder;
  /**
   * Resource Classes that accept attachments. A class must opt in; feature 04 still decides every
   * request. Empty until a content owner (feature 16 and later) registers its classes.
   */
  readonly ownerClasses: readonly string[];
  /** Unexpired pending uploads per actor and campaign. Default 20. */
  readonly maxActivePending?: number;
  readonly log?: AttachmentServiceLog;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

export type UploadRejection =
  | 'not_found'
  | FilePolicyViolation
  | 'invalid_visibility'
  | 'target_mode_not_allowed'
  | 'target_not_member'
  | 'limit_exceeded'
  | 'storage_unavailable';

export type FinalizeRejection =
  | 'not_found'
  | 'size_mismatch'
  | 'checksum_mismatch'
  | 'signature_mismatch'
  | 'upload_incomplete'
  | 'upload_expired'
  | 'upload_failed'
  | 'storage_unavailable';

export type ReadRejection = 'not_found' | 'storage_unavailable';

export type DeleteRejection = 'not_found' | 'version_conflict';

/** What a deletion (or its retry) answers. The object key and purge deadline never leave. */
export interface AttachmentTombstone {
  readonly attachmentId: string;
  readonly version: number;
  readonly deletedAt: string;
}

type Verification =
  | { readonly kind: 'verified'; readonly size: number; readonly checksum: string }
  | { readonly kind: 'missing' }
  | {
      readonly kind: 'mismatch';
      readonly reason: 'size_mismatch' | 'checksum_mismatch' | 'signature_mismatch';
    };

export class AttachmentService {
  readonly #deps: AttachmentServiceDependencies;
  readonly #now: () => Date;
  readonly #newId: () => string;

  constructor(deps: AttachmentServiceDependencies) {
    this.#deps = deps;
    this.#now = deps.now ?? (() => new Date());
    this.#newId = deps.newId ?? (() => crypto.randomUUID());
  }

  /**
   * Authorize, validate, insert one pending row, and issue one upload grant. The decision comes
   * first: nothing about the file policy or the target is answered to an unauthorized caller.
   */
  async requestUpload(
    userId: string,
    campaignId: string,
    request: AttachmentUploadRequest,
  ): Promise<Result<AttachmentUploadPermission, UploadRejection>> {
    if (!check(Id, userId) || !check(Id, campaignId)) return err('not_found');
    const owner = await this.#owner(userId, campaignId, request.owner, 'update');
    if (owner === undefined) return err('not_found');

    const violation = checkFilePolicy(request);
    if (violation !== undefined) return err(violation);
    if (!isAllowedMime(request.mime)) return err('unsupported_file_type');
    const visibility = await this.#checkVisibility(campaignId, request.visibility);
    if (!visibility.ok) return visibility;

    const active = await this.#deps.repository.countActivePending(campaignId, userId);
    if (active >= (this.#deps.maxActivePending ?? 20)) return err('limit_exceeded');

    const id = this.#newId();
    const objectKey = objectKeyFor(campaignId, id);
    const record = await this.#deps.repository.insertPending({
      id,
      campaignId,
      ownerResourceClass: request.owner.resourceClass,
      ownerResourceId: request.owner.resourceId,
      filename: request.filename,
      mime: request.mime,
      declaredSize: request.size,
      declaredChecksum: request.checksum,
      objectKey,
      visibility: visibility.value,
      createdBy: userId,
    });
    let grant: Awaited<ReturnType<ObjectStorage['createUploadGrant']>>;
    try {
      grant = await this.#deps.storage.createUploadGrant({
        key: objectKey,
        contentType: request.mime,
        size: request.size,
        checksum: request.checksum,
        expiresInSeconds: UPLOAD_GRANT_SECONDS,
      });
    } catch (error) {
      // The pending row has no usable grant; the abandoned-upload cleanup collects it.
      return this.#unavailable(error, 'upload_grant');
    }
    return ok({
      attachment: {
        attachmentId: record.id,
        status: 'pending',
        expiresAt: new Date(
          record.createdAt.getTime() + PENDING_LIFETIME_HOURS * 3_600_000,
        ).toISOString(),
      },
      upload: {
        method: 'PUT',
        url: grant.url,
        headers: { ...grant.headers },
        expiresAt: grant.expiresAt.toISOString(),
      },
    });
  }

  /**
   * Verifies the stored object (size, streamed SHA-256, file signature) and alone makes metadata
   * ready. Retrying with the same values returns the same attachment; different values change
   * nothing. Only the uploader may finalize, and only while still allowed to update the owner.
   */
  async finalize(
    userId: string,
    campaignId: string,
    attachmentId: string,
    request: AttachmentFinalizeRequest,
  ): Promise<Result<AttachmentMetadata, FinalizeRejection>> {
    if (!check(Id, userId) || !check(Id, campaignId) || !check(Id, attachmentId)) {
      return err('not_found');
    }
    const record = await this.#deps.repository.find(campaignId, attachmentId);
    if (record === undefined || record.deletedAt !== undefined || record.createdBy !== userId) {
      return err('not_found');
    }
    const owner = await this.#owner(userId, campaignId, ownerOf(record), 'update');
    if (owner === undefined) return err('not_found');

    if (request.size !== record.declaredSize) return err('size_mismatch');
    if (request.checksum !== record.declaredChecksum) return err('checksum_mismatch');
    if (record.status === 'ready') return ok(metadataOf(record));
    if (record.status === 'failed') return err('upload_failed');
    if (record.pendingExpired) return err('upload_expired');

    let verification: Verification;
    try {
      verification = await this.#verify(record);
    } catch (error) {
      return this.#unavailable(error, 'verify');
    }
    if (verification.kind === 'missing') return err('upload_incomplete');
    if (verification.kind === 'mismatch') {
      await this.#deps.repository.markFailed(campaignId, attachmentId);
      // Never-ready bytes were never synchronized, so they go now; cleanup retries on failure.
      await this.#deps.storage.delete(record.objectKey).catch(() => undefined);
      return err(verification.reason);
    }

    const ready = await this.#deps.repository.markReady(campaignId, attachmentId, {
      size: verification.size,
      checksum: verification.checksum,
      actorUserId: userId,
    });
    if (ready === undefined) {
      // A concurrent finalize or the cleanup got there first.
      const current = await this.#deps.repository.find(campaignId, attachmentId);
      if (current?.status === 'ready' && current.deletedAt === undefined) {
        return ok(metadataOf(current));
      }
      return err(current?.status === 'failed' ? 'upload_failed' : 'upload_expired');
    }
    await this.#recordUploaded(owner, ready);
    return ok(metadataOf(ready));
  }

  /** Ready attachments of one owner that the Actor may read. */
  async list(
    userId: string,
    campaignId: string,
    owner: AttachmentOwnerRef,
  ): Promise<Result<AttachmentMetadata[], 'not_found'>> {
    if (!check(Id, userId) || !check(Id, campaignId)) return err('not_found');
    const decision = await this.#owner(userId, campaignId, owner, 'read');
    if (decision === undefined) return err('not_found');
    const rows = await this.#deps.repository.listReady(campaignId, owner);
    return ok(
      rows.filter((row) => this.#narrowed(decision, row, 'read')).map((row) => metadataOf(row)),
    );
  }

  /** One ready attachment the Actor may read, or `not_found` (missing and hidden alike). */
  async resolve(
    userId: string,
    campaignId: string,
    attachmentId: string,
  ): Promise<Result<AttachmentMetadata, 'not_found'>> {
    const found = await this.#readable(userId, campaignId, attachmentId);
    return found === undefined ? err('not_found') : ok(metadataOf(found));
  }

  /** A five-minute read URL, only after a fresh decision. Nothing is cached between calls. */
  async issueRead(
    userId: string,
    campaignId: string,
    attachmentId: string,
    disposition: 'inline' | 'attachment' = 'inline',
  ): Promise<Result<AttachmentReadGrant, ReadRejection>> {
    const record = await this.#readable(userId, campaignId, attachmentId);
    if (record === undefined) return err('not_found');
    try {
      const grant = await this.#deps.storage.createReadGrant({
        key: record.objectKey,
        contentType: record.mime,
        disposition,
        ...(disposition === 'attachment' ? { filename: record.filename } : {}),
        expiresInSeconds: READ_GRANT_SECONDS,
      });
      return ok({
        attachmentId: record.id,
        method: 'GET',
        url: grant.url,
        expiresAt: grant.expiresAt.toISOString(),
        mime: record.mime,
        disposition,
      });
    } catch (error) {
      return this.#unavailable(error, 'read_grant');
    }
  }

  /**
   * Every ready attachment of the campaign the Actor may read (offline pinning set and its size
   * estimate). Each owner gets one fresh decision; hidden attachments are simply absent. A
   * non-member gets `not_found`, never an empty list that would confirm the campaign.
   */
  async listCampaign(
    userId: string,
    campaignId: string,
  ): Promise<Result<AttachmentMetadata[], 'not_found'>> {
    if (!check(Id, userId) || !check(Id, campaignId)) return err('not_found');
    const member = await this.#deps.members.resolve(userId, campaignId);
    if (!member.ok) return err('not_found');
    const decisions = new Map<string, Extract<OwnerDecision, { allowed: true }> | undefined>();
    const visible: AttachmentMetadata[] = [];
    for (const row of await this.#deps.repository.listReadyInCampaign(campaignId)) {
      const key = `${row.ownerResourceClass}:${row.ownerResourceId}`;
      if (!decisions.has(key)) {
        decisions.set(key, await this.#owner(userId, campaignId, ownerOf(row), 'read'));
      }
      const decision = decisions.get(key);
      if (decision !== undefined && this.#narrowed(decision, row, 'read')) {
        visible.push(metadataOf(row));
      }
    }
    return ok(visible);
  }

  /**
   * Versioned tombstone (`_db.md`, Deletion and Reconciliation). Bytes stay until the retention
   * window, the sync watermark and retained references allow the reconciler to purge them; new
   * read URLs are denied at once. Requires `update` on the owner, narrowed by the attachment's
   * own Visibility. Repeating the delete returns the same tombstone with an unchanged deadline.
   */
  async delete(
    userId: string,
    campaignId: string,
    attachmentId: string,
    expectedVersion: number,
  ): Promise<Result<AttachmentTombstone, DeleteRejection>> {
    if (!check(Id, userId) || !check(Id, campaignId) || !check(Id, attachmentId)) {
      return err('not_found');
    }
    const record = await this.#deps.repository.find(campaignId, attachmentId);
    if (record === undefined || record.status !== 'ready') return err('not_found');
    const owner = await this.#owner(userId, campaignId, ownerOf(record), 'update');
    if (owner === undefined || !this.#narrowed(owner, record, 'update')) return err('not_found');
    if (record.deletedAt !== undefined) {
      // A retry after a lost answer: same tombstone; the history event is deduplicated by origin.
      await this.#recordDeleted(owner, record);
      return ok(tombstoneOf(record));
    }
    if (record.version !== expectedVersion) return err('version_conflict');
    const deleted = await this.#deps.repository.markDeleted(campaignId, attachmentId, {
      expectedVersion,
      actorUserId: userId,
    });
    if (deleted === undefined) {
      const current = await this.#deps.repository.find(campaignId, attachmentId);
      if (current?.deletedAt !== undefined) return ok(tombstoneOf(current));
      return err(current === undefined ? 'not_found' : 'version_conflict');
    }
    await this.#recordDeleted(owner, deleted);
    return ok(tombstoneOf(deleted));
  }

  async #readable(
    userId: string,
    campaignId: string,
    attachmentId: string,
  ): Promise<AttachmentRecord | undefined> {
    if (!check(Id, userId) || !check(Id, campaignId) || !check(Id, attachmentId)) return undefined;
    const record = await this.#deps.repository.find(campaignId, attachmentId);
    if (record === undefined || record.status !== 'ready' || record.deletedAt !== undefined) {
      return undefined;
    }
    const decision = await this.#owner(userId, campaignId, ownerOf(record), 'read');
    if (decision === undefined || !this.#narrowed(decision, record, 'read')) return undefined;
    return record;
  }

  async #owner(
    userId: string,
    campaignId: string,
    owner: AttachmentOwnerRef,
    capability: Capability,
  ): Promise<Extract<OwnerDecision, { allowed: true }> | undefined> {
    if (!this.#deps.ownerClasses.includes(owner.resourceClass)) return undefined;
    if (!check(Id, owner.resourceId)) return undefined;
    const decision = await this.#deps.authorizer.authorizeOwner(userId, {
      campaignId,
      resourceClass: owner.resourceClass,
      resourceId: owner.resourceId,
      capability,
    });
    return decision.allowed ? decision : undefined;
  }

  #narrowed(
    owner: Extract<OwnerDecision, { allowed: true }>,
    record: AttachmentRecord,
    capability: Capability,
  ): boolean {
    return this.#deps.authorizer.decide(owner.actor, capability, {
      ...owner.facts,
      visibility: record.visibility,
    });
  }

  async #checkVisibility(
    campaignId: string,
    candidate: Visibility,
  ): Promise<Result<Visibility, UploadRejection>> {
    if (!check(VisibilitySchema, candidate)) return err('invalid_visibility');
    const visibility = normalizeVisibility(candidate);
    if (visibility.mode === 'party') return err('target_mode_not_allowed');
    if (visibility.mode !== 'players') return ok(visibility);
    if (visibility.playerIds.length > MAX_VISIBILITY_TARGETS) return err('invalid_visibility');
    const resolved = await Promise.all(
      visibility.playerIds.map((playerId) => this.#deps.members.resolve(playerId, campaignId)),
    );
    return resolved.every((result) => result.ok) ? ok(visibility) : err('target_not_member');
  }

  async #verify(record: AttachmentRecord): Promise<Verification> {
    const stored = await this.#deps.storage.inspect(record.objectKey);
    if (stored === undefined) return { kind: 'missing' };
    // HEAD first, so an oversized object is never streamed.
    if (stored.size !== record.declaredSize) return { kind: 'mismatch', reason: 'size_mismatch' };
    const digest = await digestStream(this.#deps.storage.read(record.objectKey));
    if (digest.size !== record.declaredSize) return { kind: 'mismatch', reason: 'size_mismatch' };
    if (digest.checksum !== record.declaredChecksum) {
      return { kind: 'mismatch', reason: 'checksum_mismatch' };
    }
    if (!matchesFileSignature(record.mime, digest.head)) {
      return { kind: 'mismatch', reason: 'signature_mismatch' };
    }
    return { kind: 'verified', size: digest.size, checksum: digest.checksum };
  }

  async #recordUploaded(
    owner: Extract<OwnerDecision, { allowed: true }>,
    record: AttachmentRecord,
  ): Promise<void> {
    if (this.#deps.audit === undefined) return;
    // The attachment ID is the origin: a retried finalize can never store a second event. The
    // snapshot is the attachment's Visibility on its owner, so history follows the attachment.
    await this.#deps.audit.recordCampaign({
      originMutationId: record.id,
      targetVisibility:
        owner.facts.authorUserId === undefined
          ? { visibility: record.visibility }
          : { visibility: record.visibility, authorUserId: owner.facts.authorUserId },
      event: {
        campaignId: record.campaignId,
        actor: owner.actor,
        action: 'attachment.uploaded',
        targetType: record.ownerResourceClass,
        targetId: record.ownerResourceId,
        after: { mime: record.mime, size: record.declaredSize },
        at: this.#now().toISOString(),
        private: false,
      },
    });
  }

  async #recordDeleted(
    owner: Extract<OwnerDecision, { allowed: true }>,
    record: AttachmentRecord,
  ): Promise<void> {
    if (this.#deps.audit === undefined) return;
    await this.#deps.audit.recordCampaign({
      // One stable origin per attachment deletion: retries resolve to the same single event.
      originMutationId: deriveAuditEventId(`attachment.deleted:${record.id}`),
      targetVisibility:
        owner.facts.authorUserId === undefined
          ? { visibility: record.visibility }
          : { visibility: record.visibility, authorUserId: owner.facts.authorUserId },
      event: {
        campaignId: record.campaignId,
        actor: owner.actor,
        action: 'attachment.deleted',
        targetType: record.ownerResourceClass,
        targetId: record.ownerResourceId,
        before: { mime: record.mime, size: record.declaredSize },
        at: this.#now().toISOString(),
        private: false,
      },
    });
  }

  #unavailable(error: unknown, operation: string): Result<never, 'storage_unavailable'> {
    if (!(error instanceof ObjectStorageUnavailable)) throw error;
    this.#deps.log?.storageUnavailable(operation);
    return err('storage_unavailable');
  }
}

function ownerOf(record: AttachmentRecord): AttachmentOwnerRef {
  return { resourceClass: record.ownerResourceClass, resourceId: record.ownerResourceId };
}

function tombstoneOf(record: AttachmentRecord): AttachmentTombstone {
  if (record.deletedAt === undefined) throw new Error('attachment_not_deleted');
  return {
    attachmentId: record.id,
    version: record.version,
    deletedAt: record.deletedAt.toISOString(),
  };
}

/** Public metadata of a ready row. The object key and verification internals never leave. */
export function metadataOf(record: AttachmentRecord): AttachmentMetadata {
  if (record.status !== 'ready' || record.finalizedAt === undefined) {
    throw new Error('attachment_not_ready');
  }
  return {
    attachmentId: record.id,
    campaignId: record.campaignId,
    owner: ownerOf(record),
    filename: record.filename,
    mime: record.mime,
    size: record.verifiedSize ?? record.declaredSize,
    checksum: record.verifiedChecksum ?? record.declaredChecksum,
    status: 'ready',
    visibility: record.visibility,
    version: record.version,
    createdAt: record.createdAt.toISOString(),
    createdBy: record.createdBy,
    updatedAt: record.updatedAt.toISOString(),
    updatedBy: record.updatedBy,
    finalizedAt: record.finalizedAt.toISOString(),
  };
}
