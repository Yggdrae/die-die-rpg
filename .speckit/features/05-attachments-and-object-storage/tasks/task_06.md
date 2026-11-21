# Task 06: Deletion reconciliation and export manifest

Status: completed (2026-10-27), against feature 04 fixture owner classes. The manifest contributor
exists but is registered nowhere: feature 07 does not exist yet. Depends on tasks 02–05.

## Scope

- Implement versioned metadata tombstone and 30-day purge scheduler.
- Add idempotent object/metadata reconciliation and orphan/missing-object diagnostics.
- Register P0 manifest-only `ExportableModule` contribution.
- Test sync watermark/reference gates, campaign deletion, and forbidden export fields.

## Acceptance Criteria

- [x] Delete returns without inline object removal and denies new read URLs immediately.
- [x] Purge waits for retention, watermark, and retained-reference conditions.
- [x] Export contains ready metadata/checksums/Visibility and no bytes, keys, URLs, or local state.

## Verification

```bash
bun test packages/attachments
bun run typecheck
```

## Evidence

- No migration: `0008_attachment_metadata` already has `deleted_at`, `purge_after`, the
  deletion/purge pairing check and the purge index.
- Deletion: `AttachmentService.delete(userId, campaignId, attachmentId, expectedVersion)` needs
  `update` on the owner narrowed by the attachment's Visibility; hidden, missing, pending, foreign
  and unauthorized give `not_found`. Repository `markDeleted` (ready live row at the expected
  version → version + 1, `deleted_at = now()`, `purge_after = now() + 30 days`, database time). A
  retry returns the same tombstone with the deadline unchanged; a stale version on a live row is
  `version_conflict`. Route `DELETE /campaigns/:campaignId/attachments/:attachmentId
  ?expectedVersion=N` (session + same-origin; 200 `{attachmentId, version, deletedAt}`; 404 safe
  denial; 409). Reads, lists and the offline set exclude tombstones at once; no object is touched.
- History: `attachment.deleted` (payload `{mime, size}` only, on the owner, the attachment's
  Visibility as snapshot, origin derived from the attachment ID so retries store one event) is
  declared in `packages/attachments/src/audit-declarations.ts` ("Removed a PNG image (2.0 KB).")
  and listed for contributor 05 in `apps/api/src/modules/audit/contributors.ts`; the feature 06
  conformance test passes.
- `packages/attachments/src/reconciliation.ts`, `AttachmentReconciler`:
  - `run()`: (1) campaigns with live attachments whose campaign is deleted or absent
    (`CampaignLifecycle`, composed in `runtime.ts` over the campaign repository) get every live
    attachment tombstoned under the same 30-day rule (no feature 02 hook exists; at most one pass
    late); (2) tombstones past `purge_after` (exclusive, database time) are purged only when no
    retained export/import reference holds them (`RetainedAttachmentReferences`; production:
    `NO_RETAINED_ATTACHMENT_REFERENCES`, feature 07 absent) and, when given, feature 03
    `TombstonePurgeEvidence` says safe (an evidence failure retains). The object is deleted first
    (missing = success); only then the row is hard-deleted. A provider failure leaves the row for
    the next pass (the row is the retry state; nothing runs in a user transaction).
  - `diagnose()`: lists keys under `campaigns/` (new port method `ObjectStorage.list`, implemented
    by `Bun.S3Client.list`) against metadata, reports orphan objects by their campaign/attachment
    IDs (never the key), foreign keys, and ready attachments whose object is missing; it never
    deletes or restores. Page-bounded; reports `complete`.
  - Runtime runs `run()` on the cleanup interval (default hourly); counts only are logged.
- Watermark gate: attachment metadata is in no sync publication and `powersync_replicator` cannot
  read it (asserted), so no replica holds an attachment tombstone and runtime passes no evidence;
  the gate is implemented and tested for when metadata replicates (scope `attachments`,
  sequence = version).
- Export: `AttachmentManifestExporter implements ExportableModule` (`export.ts`, module
  `attachments`, chunk version `1`): `{campaignId, binaries: 'excluded', entries}`; one entry per
  ready, non-deleted attachment with ID, owner, filename, MIME, verified size and SHA-256,
  Visibility, version, created/finalized instants. Keys, URLs, provider data, device state,
  pending/failed rows, tombstones and bytes are absent. `import` validates the chunk and reports
  `attachment_import_unsupported` (a manifest cannot restore files).

Tests (with `.env`):

- `packages/attachments/src/deletion.test.ts` deletion + export blocks (8): tombstone without
  object removal and immediate read/list denial; retry keeps one tombstone, no URL, same deadline,
  one history origin; filename never in history; stale version; 7 unauthorized/hidden/foreign
  probes; pending not deletable; manifest fields exactly, no key/URL/pending/deleted; import.
- `packages/attachments/src/reconciliation.test.ts` (8): exclusive 30-day boundary then object and
  tombstone go, no restore; live rows never purged; retained reference holds; watermark blocks and
  evidence failure retains; provider failure retried and missing object converges; campaign
  deletion cascade once with fixed deadline; diagnostics report without deleting; cleanup backlog.
- `packages/attachments/src/infra/postgres/retention.integration.test.ts` (5, PostgreSQL):
  `purge_after - deleted_at = interval '30 days'` exactly; exclusive due boundary; hard-delete only
  a due tombstone; reconciler cascade + object-before-metadata over PostgreSQL; manifest from
  PostgreSQL; `attachments` in no publication and unreadable by the replication role.
- `bun-s3-storage.integration.test.ts` (+1): MinIO listing pages under a prefix; idempotent delete.
- `apps/api/src/modules/attachments/offline-deletion.routes.test.ts` (5 of 7): DELETE over HTTP
  (tombstone, retry, 409/400, byte-identical denials, cross-origin refused).
- Mutation: ignoring the retained reference fails the reference test.
- `bun test packages/attachments`: 129 pass, 0 fail. `bun run typecheck`: 11/11 workspaces exit 0.

## Open

- Feature 07 does not exist: nothing registers the exporter, and no retained export/import job
  store exists. Feature 07 must register `new AttachmentManifestExporter(repository)` and replace
  `NO_RETAINED_ATTACHMENT_REFERENCES` with its job store. Binary export is P1.
- Campaign deletion is detected by reconciliation (no feature 02 deletion hook); tombstones start
  their 30 days at detection, not at the campaign's deletion instant (later, never earlier).
- `diagnose()` has no scheduled run or operator CLI; it is a module API.
- No production owner class (feature 16).
