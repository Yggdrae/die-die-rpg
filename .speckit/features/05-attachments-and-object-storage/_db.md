# Data Design: Attachments and Object Storage

Source: `_prd.md`, `_bdd.md`, feature 03 `_db.md`, feature 04 `_db.md`, and the frozen
`AttachmentRef` contract.

## Sources of Truth

PostgreSQL is authoritative for attachment metadata and lifecycle. S3-compatible object storage is
authoritative for bytes. Browser Cache Storage/OPFS holds disposable cached or explicitly pinned
bytes; SQLite stores per-device availability metadata. Binary content never enters PostgreSQL,
PowerSync rows, audit payloads, or application logs.

## PostgreSQL Schema

### `attachments`

| Column | Constraints / meaning |
| --- | --- |
| `id uuid` | primary key; client-visible stable ID |
| `campaign_id uuid` | indexed campaign scope |
| `owner_resource_class text`, `owner_resource_id uuid` | opaque owner reference resolved through feature 04 declaration |
| `filename text` | 1–255 Unicode code points; control/path separators rejected |
| `mime_type text` | P0 allowlist check |
| `declared_size bigint` | 1 through 26,214,400 bytes |
| `verified_size bigint` | nullable until finalization; must equal declared size |
| `declared_checksum bytea` | 32-byte SHA-256 |
| `verified_checksum bytea` | nullable; must equal declared checksum |
| `object_key text` | unique opaque server-generated key; never user filename |
| `status text` | pending, ready, failed |
| `visibility_mode`, `visibility_targets` | feature 04 standard representation |
| `version bigint` | starts at 1 |
| `created_at`, `updated_at timestamptz` | required |
| `created_by`, `updated_by uuid` | authoritative actor IDs |
| `finalized_at`, `failed_at`, `deleted_at timestamptz` | lifecycle instants |
| `purge_after timestamptz` | nullable; fixed when deleted |

Indexes: unique object key; `(campaign_id, owner_resource_class, owner_resource_id)` for listing;
pending rows by `created_at`; ready active rows by campaign; deleted rows by `purge_after` for
cleanup. Only `ready AND deleted_at IS NULL` rows are visible through `AttachmentRef` resolution.

Allowed MIME values are `application/pdf`, `image/jpeg`, `image/png`, and `image/webp`. Finalization
also verifies the actual file signature matches the declared allowed type. A mismatch marks the row
failed and schedules bytes for cleanup.

## Object Layout and Credentials

Use one private bucket per deployment and keys shaped as
`campaigns/<campaign-uuid>/<attachment-uuid>/<random-uuid>`. Filenames and secrets never appear in
keys. Bucket listing is denied to clients.

- Signed upload URL lifetime: 10 minutes; bound to one key, exact content length, checksum, and
  declared content type where the provider supports those conditions.
- Signed read URL lifetime: 5 minutes; issued only after a fresh authorization decision.
- URLs and signing credentials are redacted from logs, audit, sync, and exports.
- Cross-origin attachment serving must preserve the application's COOP/COEP requirements. PDFs are
  downloaded or rendered in a sandboxed separate origin; images use inert content handling.

An already issued URL may remain usable until its short expiry after deletion or visibility change.
Correctness relies on the five-minute ceiling and denial of renewal; immediate revocation would
require proxying bytes, which P0 rejects.

## Upload Lifecycle

1. Authorize owner/campaign/visibility and validate filename, declared size, MIME, and checksum.
2. Insert one `pending` metadata row and issue one bound upload URL.
3. Client uploads directly to object storage.
4. Finalize locks the row, performs object HEAD plus streamed checksum/signature verification, and
   changes it to `ready` only on an exact match.
5. Repeating finalize with the same verified values returns the same attachment. Different values
   reject and never create a second attachment.

Pending uploads expire after 24 hours. Cleanup deletes their objects and hard-deletes pending/failed
metadata after 7 days because such rows were never synchronized as visible attachments.

## Deletion and Reconciliation

Ready attachment deletion increments version, sets `deleted_at`, and sets `purge_after` to exactly
30 days later. It does not delete bytes inline. New read URLs are denied immediately.

The reconciliation worker:

- deletes the object only after `purge_after`, feature 03's tombstone watermark, and absence of any
  retained export/import job reference;
- records retry state outside user transactions;
- treats missing object as successful convergence;
- detects orphan objects and metadata-with-missing-object without restoring either silently;
- hard-deletes metadata only after object deletion is confirmed and the sync tombstone is safe.

Campaign deletion schedules every attachment under the same 30-day rule.

## Local Offline Schema and Bytes

`attachment_local_state` is device-local and never synchronized:

| Column | Meaning |
| --- | --- |
| `attachment_id text` | primary key |
| `campaign_id text` | cleanup scope |
| `state text` | cloud_only, cached, pinned, downloading, unavailable |
| `local_key text` | nullable opaque cache key |
| `verified_size integer`, `verified_checksum text` | local integrity |
| `downloaded_bytes integer` | progress |
| `last_accessed_at text` | cache eviction only |
| `pin_requested_at text` | nullable explicit intent |

Cached bytes are evictable; pinned bytes are not. Campaign pin estimate is the sum of verified sizes
for visible ready attachments not already present with matching checksum. The acceptance tolerance
is exact payload bytes: actual verified stored payload must be within max(1 MiB, 1%) of the estimate;
protocol overhead is excluded.

Visibility narrowing or membership revocation aborts an in-progress download and deletes cached or
pinned bytes when the revocation signal is processed. A device offline at revocation may retain
bytes until reconnect; server URLs and writes already fail closed. Sign-out deletes all local bytes.

## Sync and Conflicts

Only ready/tombstoned metadata synchronizes through feature 03. Pending upload rows and signed URLs
never do. Visibility filters apply before metadata (including filename) leaves the authority.
Binary download is a separate authorized operation.

Attachment metadata updates and deletes use expected version. Bytes are immutable after finalization;
replacing a file creates a new attachment and tombstones the old one. This avoids binary merge and
checksum ambiguity.

## Export

P0 contributes manifest entries for ready attachments: remappable attachment ID, owner reference,
safe filename, MIME, verified size/checksum, Visibility, and deletion exclusion. Object keys, signed
URLs, local paths/states, credentials, failed/pending rows, and binary bytes are excluded. Binary
inclusion is P1.

## Migration and Operations

1. Add attachment schema/migration and private bucket configuration.
2. Verify provider lifecycle, checksum constraints, CORS, and separate-origin rendering against
   MinIO before enabling routes.
3. Add cleanup/reconciliation worker with dry-run metrics, then enable deletion.
4. Add local-state migration independently of synchronized metadata tables.

Object operations are not transactionally rolled back with PostgreSQL. Every transition is
idempotent and reconciliation closes gaps.

## Required Data Tests

- Database checks reject unlisted MIME, >25 MB, malformed checksum, invalid visibility, and unsafe filename.
- Finalization verifies size, checksum, and file signature; retry is idempotent.
- Pending expiry and 30-day deletion boundaries use database time and exclusive comparisons.
- Reconciliation handles missing/orphan objects and provider retry without duplicate rows.
- Hidden metadata and filenames never reach a player replica.
- Revocation deletes local cached/pinned bytes after synchronization.
- Pinned content survives restart and opens offline with checksum validation.
- Estimate accuracy meets max(1 MiB, 1%) on the fixture campaign.
- P0 export contains manifest metadata and no binary/object credential.

