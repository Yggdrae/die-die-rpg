# Data Design: Campaign Import and Export

Source: `_prd.md`, `_bdd.md`, frozen `ExportableModule` contracts, and Track A data documents.

## Format and Storage Decisions

`.rpgpack` is a ZIP container with UTF-8 JSON entries and normalized forward-slash paths. P0 may
use deflate compression. The format is internal and versioned but not yet a public compatibility
promise. Attachment binaries and audit events are excluded from P0.

Export reads authoritative PostgreSQL when online and a complete synchronized SQLite replica when
offline. Generated files are client-owned downloads; the server does not retain package bytes.
Import treats every byte as untrusted and stages only bounded metadata in memory/temporary storage
until validation completes.

## Required Container Layout

```text
manifest.json
campaign.json
system.lock
modules.lock
entities/<module-id>.json
documents/<module-id>.json
attachments-manifest/attachments.json
unknown/<module-id>/<chunk-version>.json
```

The manifest contains format version, application version, export timestamp, safe exporter display
identity, campaign ID for provenance only, SHA-256 for every entry, and sorted contributor records
`{moduleId, chunkVersion, path, checksum}`. Import assigns new domain IDs.

Limits checked before extraction:

- 250 MB compressed package;
- 500 MB total uncompressed content;
- 10,000 entries;
- 50 MB per JSON entry;
- no duplicate, absolute, backslash, drive-letter, `..`, symlink, or unsupported entry path;
- compression ratio at most 100:1 per entry.

All JSON receives TypeBox validation and depth/string/array limits from the contributor schema.

## PostgreSQL Schema

### `export_jobs`

| Column | Meaning |
| --- | --- |
| `id uuid` | primary key |
| `campaign_id uuid`, `requested_by uuid` | authorization/audit scope |
| `state text` | requested, running, completed, failed |
| `manifest_checksum bytea` | nullable completion evidence |
| `contributor_summary jsonb` | safe module/count/version summary |
| `created_at`, `completed_at timestamptz` | lifecycle |
| `error_code text` | nullable safe failure code |

Jobs contain no package bytes, raw secrets, or signed download URL. Offline-only exports do not
need a server job; they create equivalent device-local status and audit on later synchronization.
Server job rows retain 30 days for diagnostics, then hard-delete.

### `import_jobs`

Tracks idempotent orchestration and report output: job/user IDs, source manifest checksum, state,
new campaign ID only after commit, contributor report/warnings JSONB, safe error code, and lifecycle
timestamps. A deliberate second import of the same checksum is allowed and creates another campaign;
idempotency applies only to retrying one job ID. Retain 90 days.

### `import_preserved_chunks`

| Column | Meaning |
| --- | --- |
| `campaign_id uuid` | new imported campaign |
| `module_id text`, `chunk_version text` | opaque identity |
| `payload jsonb` | validated as bounded JSON but not interpreted |
| `payload_checksum bytea` | round-trip proof |
| `created_at timestamptz` | lifecycle |

Primary key `(campaign_id, module_id, chunk_version)`. Unknown chunks are never queried as domain
data, synchronized to players, or executed. They reappear byte-for-byte canonically on later export.
They delete only with the campaign under feature 02's eventual hard-delete policy.

## Export Consistency

Online export runs all contributor reads in one PostgreSQL `REPEATABLE READ READ ONLY` transaction
or at one feature 03 authority cursor. Offline export requires every registered P0 contributor to
report its local replica complete at one cursor. If completeness cannot be proved, export fails with
an explicit `incomplete_replica` result rather than silently producing a partial backup.

Contributors return validated chunks only through `ExportableModule`. The orchestrator sorts paths
and keys for deterministic checksums and never imports their internal schema. Package generation is
streamed so typical exports do not duplicate the full archive in memory.

## Atomic Import

1. Inspect central directory and enforce limits/path rules without extraction.
2. Validate manifest, required entries, checksums, lock files, and every recognized chunk.
3. Require the exact pinned system version to be installed. Missing system blocks before write;
   no substitution is offered.
4. Build a complete old-to-new ID map. Membership identities are not restored.
5. Begin one PostgreSQL transaction shared by feature 02 and every registered contributor.
6. Create the campaign and sole owner membership, then invoke contributors in sorted module order
   with the transaction context and ID map.
7. Store unknown chunks opaquely, commit, and publish the report.

Any contributor failure rolls back the campaign, owner, recognized data, and preserved chunks.
Contributors that use object storage cannot participate with bytes in P0; manifest-only attachment
restore creates metadata only when its contributor explicitly supports unresolved binaries, or
reports them as not restored. No partial object side effect is allowed before commit.

The frozen `ExportableModule.import(campaignId, chunk)` contract lacks transaction context and an
ID-map/report result. P0 implementation therefore requires a post-freeze additive contract revision
before tasks begin. The change must preserve existing implementers through an adapter or versioned
interface and follow feature 00's contract-change note/review process.

## Privacy and Authorization

- Export requires current `owner` or `gm`; `assistant_gm`, player, observer, and non-member deny.
- Export warns that the resulting file contains GM-only content and becomes uncontrolled.
- Credentials, password/email data, sessions, invitations, recovery tokens, object keys, signed
  URLs, local cache paths, sync queues, and private audit data are excluded.
- Visibility serializes with each contributor record and is validated before import. Target user
  mappings that cannot be restored fail closed to `gm_only` with an explicit warning; never to
  `everyone`.
- Import always creates a new campaign owned by the importer and restores no old membership.

## Migration and Cleanup

1. Add job and preserved-chunk tables in one forward migration.
2. Ratify the transaction-aware import contract change before contributor implementation.
3. Ship export first behind registry conformance tests; enable import only when every P0 required
   contributor supports validation, ID remap, and rollback.
4. Cleanup job metadata by retention; never delete user-downloaded packages.

## Required Data Tests

- ZIP traversal, duplicate paths, bombs, malformed JSON, checksum mismatch, and limit boundaries reject before writes.
- One export snapshot cannot mix contributor versions from different authority states.
- Offline export rejects an incomplete replica.
- Missing pinned system blocks and never substitutes.
- Contributor failure rolls back every PostgreSQL row including owner and preserved chunks.
- Job retry is idempotent; deliberate second import creates a distinct campaign.
- Unknown chunks survive canonical round trip unchanged and are never executed/synchronized.
- Credentials, binary attachments, audit data, URLs, and object keys are absent.
- Visibility never widens after ID remap.

## Implementation Notes (2026-10-27, tasks 02–05)

- **`export_jobs`.**
  - Shipped in migration `packages/identity/drizzle/0009_export_jobs.sql` with the columns above.
  - CHECK constraints: state, lifecycle (terminal ⇔ `completed_at`, completed ⇔ checksum,
    failed ⇔ `error_code`), 32-byte checksum, and an error-code pattern.
  - Retention: rows older than 30 days are hard-deleted in database time (exclusive), on an hourly
    API loop.
  - The table is not published to the sync provider.
- **Package bytes.** They are held only in an in-process, per-user store with a 10-minute TTL, and
  are released on delivery or expiry. A multi-instance deployment needs sticky routing or a shared
  temporary store.
- **Export consistency deviation.**
  - The frozen `export(campaignId)` cannot join a `REPEATABLE READ` transaction.
  - Online export therefore reads every contributor twice in module order and accepts only equal
    canonical checksums. Versions only increase, so a mixed authority state cannot repeat.
  - It retries up to 3 comparisons, then `snapshot_unstable`.
- **Offline export.**
  - Uses one replica cursor: complete and equal before and after the reads.
  - The current browser replica lacks the exact system and module pins and the attachment
    metadata, so it refuses with `incomplete_replica`.
- **Feature 05 retention.** `RetainedAttachmentReferences` now receives `{id, campaignId}`. Every
  attachment of a campaign with a `requested` or `running` export is retained.
- **Import tables:** built in task 06 (see below).

## Implementation Notes (2026-10-28, tasks 01, 06, 07)

- **Migration `0010_import_jobs`** adds `import_jobs` and `import_preserved_chunks` as designed above.
  - `import_jobs` CHECKs: state, lifecycle (terminal ⇔ `completed_at`, completed ⇔
    `campaign_id`, failed ⇔ `error_code`), 32-byte manifest checksum (nullable: a package that
    never parsed has none), error-code pattern, report is a JSON object. Safe failure details
    (module id, contributor safe code, unavailable pins) live in `report.failure`.
  - Retention: rows older than 90 days are hard-deleted in database time (exclusive), on the same
    hourly API loop as export jobs.
  - `import_preserved_chunks`: module/version pattern CHECKs, 32-byte `payload_checksum`. Export
    refuses a preserved payload whose canonical checksum no longer matches.
  - Neither table is published to the sync provider. No FK to `campaigns` (guard rule 11 forbids
    importing feature 02's schema); rows are written only inside the import transaction.
- **Atomic import** follows steps 1–7. The transaction is opened by feature 07
  (`PostgresImportTransactions`); feature 02 creates the campaign and feature 01 the sole owner on
  it through `PostgresCampaignRepository.createWithin`; the job completes on the same transaction.
  Any contributor failure rolls everything back (proved over PostgreSQL).
- **IDs:** new ids are `SHA-256(job id, kind, source id)` as version 8 UUIDs, so retrying one job plans
  the same ids and a new job never collides.
- **Attachments:** P0 restores no attachment rows (no binaries); the report counts them as
  `attachment_binary_not_restored`. No object-storage call happens during import.
- **Visibility:** feature 04 `visibilityForImport` narrows any targeted audience without a
  mapping to `gm_only` with a warning; the only accepted member mapping targets the importer.
- **Known limit:** a preserved payload containing a JSON ` ` cannot be stored in `jsonb`; such an
  import fails whole (`import_failed`).
