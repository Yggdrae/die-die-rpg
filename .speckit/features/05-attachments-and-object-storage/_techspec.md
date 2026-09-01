# TechSpec: Attachments and Object Storage

Source: `_prd.md`, `_bdd.md`, `_db.md`, feature 00 spike findings, and features 03/04 specs.

## Current Facts

- `AttachmentRef` and offline-state contracts exist. MinIO is declared in `compose.yaml` but the
  file notes the stack is not fully verified.
- There is no attachment package, bucket provisioning, S3 client, upload route, safe viewer, local
  byte cache, or reconciliation worker.
- The PWA must remain cross-origin isolated for feature 03.

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
- Blocking: prove the chosen S3 client/presigner under Bun and verify MinIO/COOP/COEP behavior
  before implementing routes.

