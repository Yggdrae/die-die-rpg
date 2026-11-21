import {
  check,
  type ExportableModule,
  type ExportChunk,
  err,
  Id,
  type ImportableModule,
  type ImportContext,
  type ImportPlanContribution,
  type ImportResult,
  ok,
  type Result,
  Timestamp,
  Version,
  Visibility,
} from '@rpg/contracts';
import { type Static, Type } from '@sinclair/typebox';
import type { AttachmentRecord } from './application.ts';
import { AttachmentMime, AttachmentOwnerRef, Sha256Hex } from './model.ts';

/**
 * P0 export contribution (`_prd.md` FR-014, `_db.md` Export): a manifest-only chunk for feature
 * 07's `.rpgpack` (`attachments-manifest/`). One entry per ready, non-deleted attachment, with its
 * Visibility preserved. Object keys, signed URLs, provider names, device state, pending or failed
 * uploads, tombstones and file bytes are never part of it; binary export is P1.
 *
 * Feature 07 authorizes the export request (the whole campaign) and registers
 * `new AttachmentManifestExporter(repository)`.
 *
 * Import (transaction-aware contract, note 2026-10-27): P0 packages carry no binaries, and an
 * attachment row without its verified bytes would be a broken record, so `restore` restores
 * nothing and reports every entry as `attachment_binary_not_restored`. It never writes and never
 * calls object storage. The frozen `import` is not called by feature 07.
 */

export const ATTACHMENT_EXPORT_MODULE_ID = 'attachments';
export const ATTACHMENT_MANIFEST_VERSION = '1';

export const AttachmentManifestEntry = Type.Object(
  {
    /** Remappable by feature 07 on import. */
    attachmentId: Id,
    owner: AttachmentOwnerRef,
    filename: Type.String({ minLength: 1 }),
    mime: AttachmentMime,
    size: Type.Integer({ minimum: 1 }),
    checksum: Sha256Hex,
    visibility: Visibility,
    version: Version,
    createdAt: Timestamp,
    finalizedAt: Timestamp,
  },
  { additionalProperties: false },
);
export type AttachmentManifestEntry = Static<typeof AttachmentManifestEntry>;

export const AttachmentManifest = Type.Object(
  {
    campaignId: Id,
    binaries: Type.Literal('excluded'),
    entries: Type.Array(AttachmentManifestEntry),
  },
  { additionalProperties: false },
);
export type AttachmentManifest = Static<typeof AttachmentManifest>;

export const ATTACHMENT_BINARY_NOT_RESTORED = 'attachment_binary_not_restored';

/** Metadata for the offline export (`campaign_export_metadata`). Never the object key. */
export const ATTACHMENT_EXPORT_REPLICA_TABLES = {
  attachments: {
    columns: {
      campaign_id: 'text',
      owner_resource_class: 'text',
      owner_resource_id: 'text',
      filename: 'text',
      mime_type: 'text',
      declared_size: 'integer',
      verified_size: 'integer',
      declared_checksum: 'text',
      verified_checksum: 'text',
      visibility_mode: 'text',
      visibility_targets: 'text',
      version: 'integer',
      created_at: 'text',
      finalized_at: 'text',
    },
    indexes: { campaign: ['campaign_id'] },
  },
} as const;

/** What the manifest reads: the authority's repository, or the device replica when offline. */
export interface AttachmentManifestSource {
  listReadyInCampaign(
    campaignId: string,
  ): Promise<
    readonly Pick<
      AttachmentRecord,
      | 'id'
      | 'ownerResourceClass'
      | 'ownerResourceId'
      | 'filename'
      | 'mime'
      | 'declaredSize'
      | 'verifiedSize'
      | 'declaredChecksum'
      | 'verifiedChecksum'
      | 'visibility'
      | 'version'
      | 'createdAt'
      | 'finalizedAt'
    >[]
  >;
}

export class AttachmentManifestExporter implements ExportableModule, ImportableModule {
  readonly moduleId = ATTACHMENT_EXPORT_MODULE_ID;
  readonly importChunkVersions = [ATTACHMENT_MANIFEST_VERSION] as const;

  constructor(private readonly repository: AttachmentManifestSource) {}

  async export(campaignId: string): Promise<ExportChunk> {
    const rows = await this.repository.listReadyInCampaign(campaignId);
    const payload: AttachmentManifest = {
      campaignId,
      binaries: 'excluded',
      entries: rows.flatMap((row) =>
        row.finalizedAt === undefined
          ? []
          : [
              {
                attachmentId: row.id,
                owner: { resourceClass: row.ownerResourceClass, resourceId: row.ownerResourceId },
                filename: row.filename,
                mime: row.mime,
                size: row.verifiedSize ?? row.declaredSize,
                checksum: row.verifiedChecksum ?? row.declaredChecksum,
                visibility: row.visibility,
                version: row.version,
                createdAt: row.createdAt.toISOString(),
                finalizedAt: row.finalizedAt.toISOString(),
              },
            ],
      ),
    };
    return { moduleId: this.moduleId, chunkVersion: ATTACHMENT_MANIFEST_VERSION, payload };
  }

  /** Write-free: the manifest's attachment ids, and one warning for the unrestored binaries. */
  async validate(chunk: ExportChunk): Promise<Result<ImportPlanContribution, string>> {
    if (
      chunk.moduleId !== this.moduleId ||
      chunk.chunkVersion !== ATTACHMENT_MANIFEST_VERSION ||
      !check(AttachmentManifest, chunk.payload)
    ) {
      return err('attachment_manifest_invalid');
    }
    const entries = chunk.payload.entries;
    return ok({
      defines: entries.map((entry) => ({ kind: 'attachment', sourceId: entry.attachmentId })),
      warnings:
        entries.length === 0
          ? []
          : [{ code: ATTACHMENT_BINARY_NOT_RESTORED, count: entries.length }],
    });
  }

  /** P0: nothing is restored (no binaries); the warning comes from `validate`. */
  async restore(
    chunk: ExportChunk,
    _context: ImportContext,
  ): Promise<Result<ImportResult, string>> {
    const validated = await this.validate(chunk);
    return validated.ok ? ok({ restoredCount: 0, warnings: [] }) : validated;
  }

  async import(_campaignId: string, chunk: ExportChunk) {
    if (
      chunk.moduleId !== this.moduleId ||
      chunk.chunkVersion !== ATTACHMENT_MANIFEST_VERSION ||
      !check(AttachmentManifest, chunk.payload)
    ) {
      return err('attachment_manifest_invalid');
    }
    return err('attachment_import_unsupported');
  }
}
