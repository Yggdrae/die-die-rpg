# Task 06: Atomic import planner and coordinator

Status: completed (2026-10-28). Migration `0010_import_jobs`. Depends on tasks 01–03 plus
feature 01/02 and required contributor adapters.

## Scope

- Add import-job/preserved-chunk migrations and pre-write plan validation.
- Require exact installed system, build deterministic ID map, and create importer as sole owner.
- Invoke recognized contributors in one opaque transaction; preserve unknown chunks bounded/opaque.
- Roll back on any contributor failure and retain safe warnings/report for 90 days.

## Acceptance Criteria

- Failed import leaves no campaign, owner, contributor row, or preserved chunk.
- Missing system blocks before write and never substitutes.
- Unknown chunks survive canonical round trip and targeted unmapped visibility narrows to `gm_only` with warning.

## Verification

```bash
bun test packages/campaign-portability packages/campaigns packages/identity
bun run typecheck
```

## Former blocker (2026-10-27, resolved 2026-10-28 by task 01)

- The frozen `ExportableModule.import(campaignId, chunk)` has no shared transaction, no ID map, no
  report, and no write-free validation phase. An atomic import cannot be built on it honestly.
- The proposed revision is awaiting one approval per track:
  `00-platform-foundation/2026-10-27-transaction-aware-import-contract-change.md`.
- Ready to reuse once unblocked (from tasks 02–03):
  - `inspectPackage` validates the whole package before any write: layout, limits, checksums,
    locks and chunk envelopes.
  - `ExportRegistry` gives the sorted contributor order.
  - `PreservedChunkSource` already re-emits preserved unknown chunks under `unknown/` on export.
- The current P0 contributors answer the frozen `import` with a safe code and write nothing:
  - `CampaignExporter.import` returns `campaign_import_requires_transaction_contract`.
  - `AttachmentManifestExporter.import` returns `attachment_import_unsupported`.

## Implementation (2026-10-28)

### Migration

`packages/identity/drizzle/0010_import_jobs.sql` (`bun run db:generate --name import_jobs`, applied
with `bun run db:migrate`; journal and snapshot formatted with Biome):

- `import_jobs`: id, requested_by, source_manifest_checksum (32 bytes, nullable for a package that
  never parsed), state `running|completed|failed`, campaign_id (exactly when completed), report
  jsonb (object), error_code (exactly when failed), created_at, completed_at. Lifecycle CHECKs as
  `export_jobs`. 90-day database-time retention (exclusive), hourly API loop.
- `import_preserved_chunks`: PK (campaign_id, module_id, chunk_version); payload jsonb;
  payload_checksum (SHA-256 of canonical JSON, 32 bytes); module/version pattern CHECKs.
- Neither table is in the `powersync` publication (asserted by the integration test). No FK to
  `campaigns`: the portability package may not import feature 02's schema (guard rule 11), and
  rows are written only inside the import transaction that creates the campaign.

### Package `@rpg/campaign-portability`

- `importer.ts`:
  - `planImport` (write-free): exact pins through a `RulesAvailability` port (`system_unavailable`
    / `module_unavailable` with the package's own pins), the campaign root must be
    transaction-aware, every recognized chunk's `validate`, deterministic id map
    (`deriveImportId`: SHA-256 of job id + kind + source id as a version 8 UUID; reserved kinds
    `campaign`, `member`), approved member mapping (target must be the importer), and preserved
    chunks with a reason (`unknown_module`, `contributor_not_transactional`,
    `chunk_version_unsupported`, `preserved_from_package`). Contributor errors are kept only when
    they are safe codes; malformed contributions are `contributor_mismatch`.
  - `ImportCoordinator.commit`: one `ImportTransactionRunner` transaction; root first, then module
    order; preserved chunks and job completion on the same transaction; any err, throw or
    malformed result rolls back (`contributor_failed` / `contributor_mismatch` with module id).
  - `importableOf`, `isImportableModule`; the registry accepts an optional `importer` per module.
- `import-jobs.ts`: `ImportService` (inspect → plan → create job → commit; retry idempotent per job
  id and user; `job_conflict` for another user; invalid packages fail the job before any write;
  post-commit `committed` hook never fails the import), `MemoryImportStore`.
- `infra/postgres/import-jobs.ts` (`./postgres`): `PostgresImportTransactions` (feature 07 opens
  the transaction; capability → handle in a WeakMap, closed after settle),
  `importTransactionHandle` (composition root only), `PostgresImportCommitStore`,
  `PostgresImportJobRepository`, `PostgresPreservedChunkSource` (export side; refuses a payload
  whose canonical checksum changed).
- `testing.ts`: `importContributorProblems` conformance kit.

### Contributors

- Feature 02: `CampaignImporter` (`packages/campaigns/src/import.ts`): same validation as creation
  against the exact system and module versions; unregistered setting namespaces reported as
  `setting_not_restored`, registered ones keep their declared member visibility;
  `PostgresCampaignRepository.createWithin(handle, …)` creates campaign, pins, settings and feature
  01's sole owner (`CampaignMembershipWriter.createOwner`) on the import transaction.
  `CampaignService.recordImported` records the new, declared audit event `campaign.imported` after
  commit (feature 06 conformance: declaration, inventory row, sample and text).
- Feature 05: `AttachmentManifestExporter` implements `ImportableModule`: defines attachment ids,
  restores nothing (P0 has no binaries; a row without verified bytes would be broken) and reports
  `attachment_binary_not_restored` with the count. It never writes or calls object storage.
- Feature 04: `visibilityForImport` (`packages/authorization/src/import-visibility.ts`): targeted
  Visibility survives only when every target maps (`member` / `party`), otherwise `gm_only` with
  `visibility_narrowed_to_gm_only`; never wider. No P0 contributor restores targeted records yet;
  the rule is exercised by a test contributor over PostgreSQL.
- Feature 06: audit is never exported or imported (manifest `audit: 'excluded'`); the import
  records only `campaign.imported` on the new campaign.

### API (`apps/api/src/modules/portability`)

- `POST /imports/:jobId` (body: the `.rpgpack`, `application/zip` or `application/octet-stream`,
  250 MB body limit; authenticated + same-origin) → 201 job view; 404 safe denial for another
  user's job id. `GET /imports/:jobId` → the requesting user's job only. Inspect and commit run
  in one request (allowed by `_techspec.md` API), so bytes never outlive the request. Not
  campaign-content routes (no campaign exists before commit); the new campaign's access is then
  feature 04's like any other.
- `app.ts`: Fastify's own 4xx rejections (413, 415, malformed body) keep their status with a fixed
  safe code instead of becoming 500.
- `runtime.ts`: the import composition, preserved chunks re-emitted on export, import job retention.

### Tests

| File | Tests |
| --- | ---: |
| `packages/campaign-portability/src/importer.test.ts` | 16 |
| `packages/campaign-portability/src/infra/postgres/import-jobs.integration.test.ts` | 4 |
| `packages/campaigns/src/import.test.ts` | 4 |
| `packages/authorization/src/import-visibility.test.ts` | 5 |
| `packages/attachments/src/deletion.test.ts` (import block) | +1 |
| `apps/api/src/modules/portability/composition.test.ts` (import conformance kit) | (existing test, extended) |
| `apps/api/src/campaign-import.integration.test.ts` (runtime + PostgreSQL) | 6 |

Mutation check: making the coordinator swallow a contributor `err` fails 3 tests (unit rollback,
service failure, PostgreSQL rollback).

### Verification

| Command | Result |
| --- | --- |
| `bun test packages/campaign-portability packages/campaigns packages/identity` (+ contracts, authorization, attachments, API portability/audit, import/export integration, web portability) | 678 pass, 0 fail |
| `bun run typecheck` | 12/12 workspaces exit 0 |

### Gaps

- No P0 contributor restores a targeted record yet (attachments restore nothing), so the
  narrowing rule has no production data path until features 15–19 contribute.
- No approved member mapping is exposed over HTTP or in the UI; `planImport` accepts one
  (`memberMapping`, importer-only targets) for a later flow.
- A preserved payload containing a JSON ` ` cannot be stored in `jsonb`; such an import fails
  as `import_failed` with nothing written.
- Package bytes are read whole into memory (≤ 250 MB) for the request.
