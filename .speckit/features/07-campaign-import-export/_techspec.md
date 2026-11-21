# TechSpec: Campaign Import and Export

Source: `_prd.md`, `_bdd.md`, `_db.md`, frozen registry contracts, and Track A feature artifacts.

## Current Facts

Feature 16 note (2026-10-30): `content` (`entities/content.json`) is registered; `ContentExporter` is
its own `ImportableModule` and the first P0 contributor that restores targeted records, so Visibility
narrowing now has a production path. Personal notes are never exported. See feature 16 tasks 15, 17.

Updated 2026-10-27, after tasks 02–05.

- `packages/campaign-portability` exists. It holds:
  - the bounded `.rpgpack` writer and inspector, hand-written ZIP with no new dependency;
  - `ExportRegistry`, `ExportOrchestrator` and the forbidden-data scanner;
  - online export jobs (`export_jobs`, migration `0009`);
  - the offline replica consistency.
- Registered P0 contributors:
  - `campaign`: feature 02 `CampaignExporter`, the campaign root plus exact pins.
  - `attachments`: feature 05 `AttachmentManifestExporter`, manifest only.
- Online export: `POST /campaigns/:campaignId/exports`, `GET /exports/:jobId`, and
  `GET /exports/:jobId/file`. All three use `ContentAccess.requireResource`, capability
  `export` on `campaign`, which is `owner`/`gm` only.
- Consistency (no transaction can be shared through the frozen `export`):
  - Online uses a verified double read.
  - Offline uses a replica cursor with completeness.
- The browser replica cannot prove completeness today (no exact pins, no attachment metadata), so
  offline export refuses with `incomplete_replica`.
- Import (updated 2026-10-28, tasks 01, 06, 07):
  - The transaction-aware contract (`ImportableModule`, `ImportContext`, `ImportResult`,
    `ImportWarning`, opaque `ImportTransaction`) was ratified 2026-10-28 by repository owner
    delegation and added to `@rpg/contracts` additively. The frozen `import` is never called.
  - `planImport` (write-free) and `ImportCoordinator` (one PostgreSQL transaction opened by feature
    07) live in `@rpg/campaign-portability`; jobs and preserved chunks in migration `0010`.
  - Contributors: feature 02 `CampaignImporter` (campaign + sole owner via feature 01 on the
    import transaction), feature 05 manifest (restores nothing, reports binaries), feature 04
    `visibilityForImport` narrowing rule.
  - API: `POST /imports/:jobId` (inspect + commit in one request) and `GET /imports/:jobId`.
  - UI: `CampaignImport` on the dashboard.
- Attachment binary inclusion and audit export are later scope; P0 is manifest-only/no audit.

## Proposed Architecture

Add `packages/campaign-portability` with:

- `ExportRegistry` validating unique module IDs and chunk versions;
- `ExportOrchestrator` reading one consistent snapshot and streaming a deterministic ZIP;
- `PackageInspector` enforcing layout, limits, paths, checksums, and TypeBox schemas;
- `ImportPlanner` resolving the exact system, contributors, warnings, and old-to-new ID map;
- `ImportCoordinator` providing one PostgreSQL transaction to campaign creation and contributors;
- job/preserved-chunk repositories from `_db.md`.

Each content owner implements a versioned contributor through its public package. The orchestrator
has no character/entity/handout/session/encounter imports. React adds export warning/progress,
download, import selection/result, and module warning surfaces.

## Required Contract Revision

Create a feature 00 contract-change note and add a versioned import interface such as:

```ts
interface ImportContext {
  campaignId: Id;
  mapId(source: Id, kind: string): Id;
  transaction: ImportTransaction;
}

interface ImportResult {
  restoredCount: number;
  warnings: readonly ImportWarning[];
}
```

The transaction is an opaque capability, not a PostgreSQL/Drizzle type. Existing
`ExportableModule.import` remains adapted/deprecated until all contributors migrate. This change is
blocking and follows the frozen one-reviewer-per-track process.

## API

| Method | Path | Authorization | Purpose |
| --- | --- | --- | --- |
| POST | `/campaigns/:campaignId/exports` | owner/gm | start online consistent export |
| GET | `/exports/:jobId` | requesting user | safe status/report |
| GET | `/exports/:jobId/file` | requesting user | streamed file while job result is available |
| POST | `/imports/inspect` | authenticated | bounded validation/plan with no domain write |
| POST | `/imports/:jobId/commit` | authenticated | atomic new-campaign restore |
| GET | `/imports/:jobId` | importing user | result/warnings |

Implementation may stream inspect/commit in one request for P0 if temporary package handles cannot
be made secure; the observable two-phase rule remains validation before writes. Package bytes are
temporary and deleted after request/job completion, never placed in campaign object storage.

Offline export runs entirely in the web worker against a proven-complete replica and creates no
server job. Import requires the server in P0 because atomic contributor restore and system
availability are authority decisions.

## Export Flow

Authorize current owner/gm, acquire one repeatable snapshot/cursor, ask sorted contributors for
validated chunks, add locks/manifests, compute checksums, and stream ZIP output. A contributor
failure fails the export; no partial file is offered. Typical campaign target is one minute on the
documented fixture/reference device.

The user must acknowledge the GM-secret warning before generation. The server file handle is
short-lived and scoped to requesting user; job metadata contains no package content.

## Import Flow

Inspect central directory and limits, validate all entries/checksums, require exact pinned system,
validate recognized chunks, preserve unknown bounded JSON, build full plan/ID map, then commit once.
Feature 02 creates the campaign; feature 01 creates only the importer owner; contributors restore in
sorted order using the opaque transaction. Failure rolls back every row.

Targeted member IDs cannot be restored because memberships are not imported. Contributors convert
unmapped targeted Visibility to `gm_only` and emit a warning. This is a narrowing, never a leak.

## Security and Failure Handling

- ZIP traversal/bomb/duplicate/symlink/limit defenses from `_db.md` run before extraction.
- Unknown payloads are bounded JSON, stored opaque, never rendered/executed/synchronized.
- Missing system blocks before write; no version substitution or cross-system conversion.
- Job IDs provide retry idempotency; a deliberate new job imports a second campaign.
- Credentials, sessions, tokens, email, object keys/URLs, binary bytes, audit, and sync internals are
  forbidden by contributor conformance tests and package scanning.
- Errors return safe module/path codes, never untrusted content or stack traces.

## Testing

- Unit/property: canonical manifest/checksums, path normalization, limits, deterministic ordering,
  ID mapping, visibility narrowing.
- Contract: contributor schema/version/export/import/report and forbidden-data scanner.
- PostgreSQL: repeatable export snapshot, atomic rollback, job retry, preserved chunks.
- Fuzz/security: malformed ZIP/JSON, bombs, deep nesting, checksum substitution, duplicate IDs.
- Offline browser: complete-replica export and incomplete-replica refusal.
- Playwright: secret warning, download, successful restore, unavailable-system and unknown-chunk reports.

## Impacted Areas

- `packages/campaign-portability/` — new package, schema/migrations, format/orchestrators.
- `apps/api/src/modules/portability/` — export/import routes and temporary-file management.
- `apps/web/src/features/portability/` — flows and offline export worker.
- `packages/contracts/` plus feature 00 change note — transaction-aware import contract.
- Every P0 content owner — contributor implementation in its own package.
- Feature 02/01 — new campaign/owner transaction participants.

## Decisions and Blockers

- ZIP is the P0 container; limits are frozen in `_db.md` for implementation.
- P0 attachments are manifest only; audit is excluded.
- Exact unavailable system blocks import before write.
- Unknown chunks are preserved opaquely.
- Resolved 2026-10-28: the import-contract revision is ratified and landed (task 01).
- Resolved 2026-10-28: feature 02 (campaign + feature 01 owner) and feature 05 (manifest) expose
  transaction-aware import; import is enabled (tasks 06, 07).

