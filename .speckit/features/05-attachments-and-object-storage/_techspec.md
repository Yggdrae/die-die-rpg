# TechSpec: Attachments and Object Storage

Source: `_prd.md`, `_bdd.md`, `_db.md`, feature 00 spike findings, and features 03/04 specs.

## Current Facts

- `AttachmentRef` and offline-state contracts exist.
- Tasks 01–04 (2026-10-27): `packages/attachments` (port, `Bun.S3Client` adapter, policy,
  PostgreSQL metadata `0008_attachment_metadata`, service, abandoned-upload cleanup), API routes in
  `apps/api/src/modules/attachments/`, safe viewers in `apps/web/src/features/attachments/`, and
  the `minio-bucket` compose one-shot (private bucket, least-privilege signing user, CORS
  allowlist) exist and are verified against MinIO. See `tasks/task_01.md` for what a grant binds.
- Tasks 05–07 (2026-10-27): `OfflineAttachmentStore` (`@rpg/attachments/offline`) over an
  IndexedDB record/byte store, the campaign offline set route
  (`GET .../attachments/offline-estimate`), versioned deletion (`DELETE .../attachments/:id`,
  `attachment.deleted`), `AttachmentReconciler` (deleted-campaign cascade, 30-day purge, orphan
  and missing-object diagnostics), and `AttachmentManifestExporter`. Security and acceptance suite
  in `tasks/task_07.md`, including the normal-connection reference profile.
- Decision (task 05): attachment metadata does not replicate through PowerSync. Its read rule
  needs the owner's decision, a join to a per-record owner table that PowerSync 1.25.0 cannot
  enforce (joined-row equality ignored, 1000-parameter limit on unkeyed joins); the `attachments`
  table stays out of the publication. The device learns metadata from the authorized offline set,
  keeps it only beside bytes it was allowed to fetch, and drops both on the removal signals
  (feature 03 replica purge, absence from the offline set, a denied read).
- Amended (feature 07 task 05, 2026-10-31, delegated by the owner): the decision above still holds
  for reading attachments. Separately, `ready` metadata (never `object_key`) now streams to the
  `export` holders only (`campaign_export_metadata`, `owner` and `gm`), who read every owner class
  (feature 16 D-15), so no per-attachment rule applies. A future owner class private from a GM must
  revisit that stream.
- Clock skew (2026-10-30): a grant is signed with the API host's clock and judged by the provider's.
  A provider ahead by T shortens a grant to its lifetime minus T (read 300 s, upload 600 s; useless
  at T >= lifetime); a provider behind by T lengthens it by T, also after a revocation. Normal time
  synchronization makes this negligible, so no code compensates: deployments must keep the API and
  the store time-synchronized. The local WSL VM clock moved between 1.3 s and 4.3 s ahead of Windows (it
  falls behind, then jumps about 2.9 s forward every 35 s), which broke a test using a 3 s URL; that
  test now reads every instant from the provider's `Date` header.
- Production owner class (feature 16 task 13, 2026-10-29): `apps/api/src/main.ts` passes
  `ownerClasses: CONTENT_ATTACHMENT_OWNER_CLASSES` (= `['campaign_entity']`, from `@rpg/content`);
  personal notes and relationships are not owner classes (D-15). Entity detail mounts
  `AttachmentList` and an upload over `uploadAttachment` with the entity's current Visibility.
- Not yet: feature 07 (nothing registers the exporter or retained job references), as before.
- The PWA must remain cross-origin isolated for feature 03 (verified with attachment images).

## Proposed Architecture

Add `packages/attachments` with:

- `ObjectStorage` port: create bound upload/read grants, inspect object, stream verification,
  delete, and existence check;
- S3-compatible adapter selected after a dependency/runtime compatibility spike;
- `AttachmentService` for request/finalize/list/resolve/delete;
- PostgreSQL repository and cleanup/reconciliation jobs;
- `AttachmentExporter` implementing the frozen registry contract;
- browser `OfflineAttachmentStore` and campaign pin coordinator.

Fastify routes are thin TypeBox boundaries. React owns upload progress, safe previews, availability,
estimate/confirmation, and download progress. Consumers use the package entry point and
`AttachmentRef`, never provider types.

## API

| Method | Path | Purpose |
| --- | --- |
| POST | `/campaigns/:campaignId/attachments/uploads` | authorize policy and issue pending attachment/upload grant |
| POST | `/campaigns/:campaignId/attachments/:id/finalize` | verify object and make metadata ready |
| GET | `/campaigns/:campaignId/resources/:class/:id/attachments` | authorized ready metadata list |
| GET | `/campaigns/:campaignId/attachments/:id/read` | fresh authorization and short read URL |
| DELETE | `/campaigns/:campaignId/attachments/:id` | versioned tombstone |
| GET | `/campaigns/:campaignId/attachments/offline-estimate` | visible missing-byte total |

Upload request contains owner reference, safe filename, MIME, exact byte size, SHA-256, and
Visibility. Finalize repeats size/checksum for idempotency. No API payload carries file bytes.

## Upload and Read Flow

Feature 04 authorizes the target owner before a pending row or URL exists. The S3 adapter binds the
grant as tightly as provider support allows. Finalization performs HEAD, checksum, and signature
validation and alone changes status to ready. PDF/image rendering follows `_db.md`: inert image or
sandboxed separate-origin/document download, never injected HTML.

Read resolution reloads attachment and owner policy, obtains a fresh Decision, then issues a five-
minute URL. A cached authorization decision is insufficient. Safe API errors make hidden and missing
attachments indistinguishable.

## Persistence, Sync, and Offline

Implement `_db.md`: metadata/object separation, 24-hour pending lifetime, 30-day ready-object
retention, reconciliation, immutable bytes, and manifest-only export.

Feature 03 synchronizes ready metadata/tombstones only. The web pin coordinator queries locally
visible attachments, computes verified byte estimate, requires confirmation, and downloads with
bounded concurrency. Each download writes to a temporary local key, verifies checksum, then
atomically marks cached/pinned. Interruption resumes or restarts without exposing partial bytes.

Feature 04 visibility removal and feature 01 membership revocation cancel downloads and delete
local bytes on next connectivity. Offline stale bytes may remain until reconnect; the product does
not claim remote erasure from a disconnected device.

No WebSocket layer is required. Progress is local transfer state.

## Security

- Server-side allowlist and 25 MB limit; content-signature verification at finalization.
- Private bucket, opaque keys, least-privilege signing credentials, URL/log redaction.
- CSRF/origin protection on metadata mutations; storage CORS permits only required upload verbs.
- COOP/COEP-compatible separate-origin strategy verified against images and PDFs.
- Rate/space limits by actor and campaign to prevent abandoned-upload exhaustion; exact quotas are
  operational configuration, while the per-file product limit remains fixed.

## Failure Handling and Observability

- Provider failure leaves pending/cleanup state retryable and never exposes ready metadata early.
- Size/checksum/signature mismatch marks failed and schedules cleanup.
- Missing ready object reports unavailable, alerts reconciliation, and does not break campaign UI.
- Metrics: grant/finalize outcomes, uploaded bytes, pending age, reconciliation backlog, pin
  estimate error/progress. Labels exclude filename, key, URL, and checksum.

## Testing

- Unit: file policy boundaries, filename/key safety, lifecycle/idempotency, estimate, state machine.
- MinIO integration: bound grants, expiry, checksum/signature verification, CORS, delete/reconcile.
- PostgreSQL: ready visibility, concurrent finalize/delete, retention boundary.
- Authorization/sync: hidden metadata and bytes absent; direct identifier probe denied; revocation cleanup.
- Browser/Playwright: upload to preview under test profile, safe PDF/image rendering, campaign pin,
  restart/offline open, interruption and unavailable state.
- Export contract: manifest fields/checksums/Visibility, no binary/object secret.

## Impacted Areas

- `packages/attachments/` — new package, schema/migrations, storage port/adapter, jobs.
- `apps/api/src/modules/attachments/` — routes/composition.
- `apps/web/src/features/attachments/` — upload/view/pin UI and local store.
- `compose.yaml` and environment docs — bucket bootstrap and separate attachment origin.
- Feature 03/04 adapters — metadata sync and authorization.
- Feature 07 registry composition — manifest contributor.

## Decisions and Blockers

- P0 exports manifest only; binary export is P1.
- Pending uploads expire after 24 hours; deleted ready bytes retain 30 days.
- Signed upload/read URLs live 10/5 minutes respectively.
- Actual content signature is verified.
- Resolved (task 01): `Bun.S3Client` under Bun 1.3.14, no SDK dependency; MinIO/COOP/COEP behavior
  verified (images via CORS `crossorigin`, PDFs top-level on the storage origin, never framed).

