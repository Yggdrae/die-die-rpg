import { visibilityFromColumns, visibilityToColumns } from '@rpg/authorization';
import { type SQL, sql } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import type {
  AttachmentRecord,
  AttachmentRepository,
  AttachmentRetentionRepository,
  AttachmentStatus,
  NewPendingAttachment,
} from '../../application.ts';
import type { AttachmentOwnerRef } from '../../model.ts';
import {
  ABANDONED_METADATA_DAYS,
  type AttachmentMimeType,
  DELETED_RETENTION_DAYS,
  isAllowedMime,
  PENDING_LIFETIME_HOURS,
} from '../../policy.ts';
import { attachmentSchema } from './schema.ts';

type Database = PostgresJsDatabase<typeof attachmentSchema>;

interface Row extends Record<string, unknown> {
  id: string;
  campaign_id: string;
  owner_resource_class: string;
  owner_resource_id: string;
  filename: string;
  mime_type: string;
  declared_size: string | number;
  verified_size: string | number | null;
  declared_checksum: string;
  verified_checksum: string | null;
  object_key: string;
  status: string;
  visibility_mode: string;
  visibility_targets: unknown;
  version: string | number;
  created_at: Date | string;
  updated_at: Date | string;
  created_by: string;
  updated_by: string;
  finalized_at: Date | string | null;
  failed_at: Date | string | null;
  deleted_at: Date | string | null;
  purge_after: Date | string | null;
  pending_expired: boolean;
}

/** Database-time predicates (exclusive): a row exactly at the boundary is not yet expired. */
const PENDING_EXPIRED = sql.raw(
  `(status = 'pending' AND created_at < now() - interval '${PENDING_LIFETIME_HOURS} hours')`,
);
const ABANDONED = sql.raw(
  `(status <> 'ready' AND deleted_at IS NULL AND created_at < now() - interval '${ABANDONED_METADATA_DAYS} days')`,
);

/** Fixed once, at deletion: the retention window in database time. */
const TOMBSTONE = sql.raw(
  `deleted_at = now(), purge_after = now() + interval '${DELETED_RETENTION_DAYS} days',
   version = version + 1, updated_at = now()`,
);
/** Exclusive: a tombstone exactly at its deadline is not yet due. */
const PURGE_DUE = sql.raw('(deleted_at IS NOT NULL AND purge_after < now())');

const COLUMNS = sql.raw(`
  id, campaign_id, owner_resource_class, owner_resource_id, filename, mime_type,
  declared_size, verified_size,
  encode(declared_checksum, 'hex') AS declared_checksum,
  encode(verified_checksum, 'hex') AS verified_checksum,
  object_key, status, visibility_mode, visibility_targets, version,
  created_at, updated_at, created_by, updated_by, finalized_at, failed_at, deleted_at, purge_after
`);

export class PostgresAttachmentRepository
  implements AttachmentRepository, AttachmentRetentionRepository
{
  constructor(private readonly db: Database) {}

  async insertPending(input: NewPendingAttachment): Promise<AttachmentRecord> {
    const visibility = visibilityToColumns(input.visibility);
    return this.#one(sql`
      INSERT INTO attachments (
        id, campaign_id, owner_resource_class, owner_resource_id, filename, mime_type,
        declared_size, declared_checksum, object_key, status, visibility_mode,
        visibility_targets, created_by, updated_by
      ) VALUES (
        ${input.id}, ${input.campaignId}, ${input.ownerResourceClass}, ${input.ownerResourceId},
        ${input.filename}, ${input.mime}, ${input.declaredSize},
        decode(${input.declaredChecksum}, 'hex'), ${input.objectKey}, 'pending',
        ${visibility.mode}, ${JSON.stringify(visibility.targets)}::jsonb,
        ${input.createdBy}, ${input.createdBy}
      )
      RETURNING ${COLUMNS}, ${PENDING_EXPIRED} AS pending_expired
    `).then((record) => {
      if (record === undefined) throw new Error('attachment insert returned no row');
      return record;
    });
  }

  find(campaignId: string, attachmentId: string) {
    return this.#one(sql`
      SELECT ${COLUMNS}, ${PENDING_EXPIRED} AS pending_expired
      FROM attachments WHERE id = ${attachmentId} AND campaign_id = ${campaignId}
    `);
  }

  async countActivePending(campaignId: string, userId: string): Promise<number> {
    const [row] = await this.db.execute<{ count: string | number }>(sql`
      SELECT count(*) AS count FROM attachments
      WHERE campaign_id = ${campaignId} AND created_by = ${userId}
        AND status = 'pending' AND NOT ${PENDING_EXPIRED}
    `);
    return Number(row?.count ?? 0);
  }

  markReady(
    campaignId: string,
    attachmentId: string,
    verified: { readonly size: number; readonly checksum: string; readonly actorUserId: string },
  ) {
    // Conditional on an unexpired pending row with the same declared values: concurrent finalizes
    // and the cleanup race resolve to exactly one transition.
    return this.#one(sql`
      UPDATE attachments SET
        status = 'ready',
        verified_size = ${verified.size},
        verified_checksum = decode(${verified.checksum}, 'hex'),
        finalized_at = now(),
        updated_at = now(),
        updated_by = ${verified.actorUserId}
      WHERE id = ${attachmentId} AND campaign_id = ${campaignId}
        AND status = 'pending' AND deleted_at IS NULL AND NOT ${PENDING_EXPIRED}
        AND declared_size = ${verified.size}
        AND declared_checksum = decode(${verified.checksum}, 'hex')
      RETURNING ${COLUMNS}, false AS pending_expired
    `);
  }

  async markFailed(campaignId: string, attachmentId: string): Promise<boolean> {
    const rows = await this.db.execute(sql`
      UPDATE attachments SET status = 'failed', failed_at = now(), updated_at = now()
      WHERE id = ${attachmentId} AND campaign_id = ${campaignId} AND status = 'pending'
      RETURNING id
    `);
    return rows.length > 0;
  }

  listReady(campaignId: string, owner: AttachmentOwnerRef) {
    return this.#many(sql`
      SELECT ${COLUMNS}, false AS pending_expired FROM attachments
      WHERE campaign_id = ${campaignId}
        AND owner_resource_class = ${owner.resourceClass}
        AND owner_resource_id = ${owner.resourceId}
        AND status = 'ready' AND deleted_at IS NULL
      ORDER BY created_at, id
    `);
  }

  expiredPending(limit: number) {
    return this.#many(sql`
      SELECT ${COLUMNS}, true AS pending_expired FROM attachments
      WHERE ${PENDING_EXPIRED} ORDER BY created_at, id LIMIT ${limit}
    `);
  }

  abandoned(limit: number) {
    return this.#many(sql`
      SELECT ${COLUMNS}, ${PENDING_EXPIRED} AS pending_expired FROM attachments
      WHERE ${ABANDONED} ORDER BY created_at, id LIMIT ${limit}
    `);
  }

  async hardDeleteUnready(attachmentId: string): Promise<boolean> {
    const rows = await this.db.execute(sql`
      DELETE FROM attachments WHERE id = ${attachmentId} AND status <> 'ready' RETURNING id
    `);
    return rows.length > 0;
  }

  listReadyInCampaign(campaignId: string) {
    return this.#many(sql`
      SELECT ${COLUMNS}, false AS pending_expired FROM attachments
      WHERE campaign_id = ${campaignId} AND status = 'ready' AND deleted_at IS NULL
      ORDER BY created_at, id
    `);
  }

  markDeleted(
    campaignId: string,
    attachmentId: string,
    input: { readonly expectedVersion: number; readonly actorUserId: string },
  ) {
    return this.#one(sql`
      UPDATE attachments SET ${TOMBSTONE}, updated_by = ${input.actorUserId}
      WHERE id = ${attachmentId} AND campaign_id = ${campaignId}
        AND status = 'ready' AND deleted_at IS NULL AND version = ${input.expectedVersion}
      RETURNING ${COLUMNS}, false AS pending_expired
    `);
  }

  async campaignsWithLiveAttachments(limit: number): Promise<string[]> {
    const rows = await this.db.execute<{ campaign_id: string }>(sql`
      SELECT DISTINCT campaign_id FROM attachments
      WHERE status = 'ready' AND deleted_at IS NULL ORDER BY campaign_id LIMIT ${limit}
    `);
    return rows.map((row) => row.campaign_id);
  }

  async tombstoneCampaign(campaignId: string): Promise<number> {
    const rows = await this.db.execute(sql`
      UPDATE attachments SET ${TOMBSTONE}
      WHERE campaign_id = ${campaignId} AND status = 'ready' AND deleted_at IS NULL
      RETURNING id
    `);
    return rows.length;
  }

  purgeDue(limit: number) {
    return this.#many(sql`
      SELECT ${COLUMNS}, false AS pending_expired FROM attachments
      WHERE ${PURGE_DUE} ORDER BY purge_after, id LIMIT ${limit}
    `);
  }

  async hardDeleteTombstone(attachmentId: string): Promise<boolean> {
    const rows = await this.db.execute(sql`
      DELETE FROM attachments WHERE id = ${attachmentId} AND ${PURGE_DUE} RETURNING id
    `);
    return rows.length > 0;
  }

  async knownObjectKeys(keys: readonly string[]): Promise<Set<string>> {
    if (keys.length === 0) return new Set();
    const rows = await this.db.execute<{ object_key: string }>(sql`
      SELECT object_key FROM attachments
      WHERE object_key IN (${sql.join(
        keys.map((key) => sql`${key}`),
        sql`, `,
      )})
    `);
    return new Set(rows.map((row) => row.object_key));
  }

  readyLive(limit: number, afterId?: string) {
    const after = afterId === undefined ? sql`` : sql`AND id > ${afterId}`;
    return this.#many(sql`
      SELECT ${COLUMNS}, false AS pending_expired FROM attachments
      WHERE status = 'ready' AND deleted_at IS NULL ${after}
      ORDER BY id LIMIT ${limit}
    `);
  }

  async #one(query: SQL): Promise<AttachmentRecord | undefined> {
    const [row] = await this.#many(query);
    return row;
  }

  async #many(query: SQL): Promise<AttachmentRecord[]> {
    const rows = await this.db.execute<Row>(query);
    return rows.map(toRecord);
  }
}

function instant(value: Date | string | null): Date | undefined {
  if (value === null) return undefined;
  return value instanceof Date ? value : new Date(value);
}

function toRecord(row: Row): AttachmentRecord {
  const visibility = visibilityFromColumns(row.visibility_mode, row.visibility_targets);
  if (visibility === undefined || !isAllowedMime(row.mime_type)) {
    // Database checks make this unreachable; never guess an audience.
    throw new Error('attachment row is not canonical');
  }
  const createdAt = instant(row.created_at);
  const updatedAt = instant(row.updated_at);
  if (createdAt === undefined || updatedAt === undefined) throw new Error('attachment row time');
  return {
    id: row.id,
    campaignId: row.campaign_id,
    ownerResourceClass: row.owner_resource_class,
    ownerResourceId: row.owner_resource_id,
    filename: row.filename,
    mime: row.mime_type as AttachmentMimeType,
    declaredSize: Number(row.declared_size),
    verifiedSize: row.verified_size === null ? undefined : Number(row.verified_size),
    declaredChecksum: row.declared_checksum,
    verifiedChecksum: row.verified_checksum ?? undefined,
    objectKey: row.object_key,
    status: row.status as AttachmentStatus,
    visibility,
    version: Number(row.version),
    createdAt,
    updatedAt,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    finalizedAt: instant(row.finalized_at),
    failedAt: instant(row.failed_at),
    deletedAt: instant(row.deleted_at),
    purgeAfter: instant(row.purge_after),
    pendingExpired: row.pending_expired === true,
  };
}

export function connectAttachmentDatabase(
  connectionString: string,
  options: { max?: number } = {},
) {
  const client = postgres(connectionString, {
    max: options.max ?? 5,
    prepare: false,
    onnotice: () => undefined,
  });
  return {
    db: drizzle(client, { schema: attachmentSchema, logger: false }),
    close: async () => client.end(),
  };
}
