# Task 04: Online export jobs, API, and download

Status: completed (2026-10-27).

## Scope

- Add export-job migration/repository and owner/gm Fastify routes with TypeBox.
- Implement GM-secret acknowledgment, progress/report, user-scoped short-lived file handle, and streaming download.
- Delete temporary package bytes after completion/expiry; retain safe job metadata 30 days.
- Test player denial, retry/failure, URL/secret leakage, and typical-fixture duration.

## Acceptance Criteria

- Only current owner/gm can generate/download the file.
- Server retains no package bytes after the bounded delivery window.
- Typical fixture package is ready within one minute on the accepted profile.

## Verification

```bash
bun test packages/campaign-portability apps/api/src/modules/portability
bun run typecheck
```

## Evidence

### Migration

`packages/identity/drizzle/0009_export_jobs.sql`, generated with
`bun run db:generate --name export_jobs` and applied with `bun run db:migrate`.

- Table `export_jobs`, with exactly the `_db.md` columns.
- Checks on the state, the lifecycle, the 32-byte checksum, the error code, and the summary array.
- Indexes: `created_at` (retention), and the active campaign for the `requested`/`running`
  states.
- The table is not in the `powersync` publication; a test asserts this.

### Files

- `packages/campaign-portability/src/jobs.ts`:
  - `ExportJobRepository` and `MemoryExportJobRepository`;
  - `TemporaryPackageStore`: in-process, per-user, 10-minute TTL;
  - `OnlineExportService`: an idempotent job per client job id, and a conflict when the id belongs
    to another user or campaign.
- `packages/campaign-portability/src/infra/postgres/{schema,export-jobs}.ts`, exported as
  `@rpg/campaign-portability/postgres`. Retention is in database time and exclusive.
- `packages/campaigns/src/export.ts`: `CampaignExporter`, the feature 02 contributor.
  - Exports the campaign root: name, description, exact system pin, module pins, settings.
  - Never carries a member, the creator, a version or a tombstone.
  - `pins()` feeds `system.lock` and `modules.lock`.
- `apps/api/src/modules/portability/composition.ts`:
  - the registry (campaign, attachments);
  - `createOnlineExport`;
  - `exportJobAttachmentReferences`, which replaces `NO_RETAINED_ATTACHMENT_REFERENCES`;
  - `startExportJobRetention`.
- `apps/api/src/modules/portability/routes.ts`: three routes.
  - `POST /campaigns/:campaignId/exports` takes `{ jobId, acknowledgeGmSecrets: true }`.
  - `GET /exports/:jobId`.
  - `GET /exports/:jobId/file`.
  - All three use `config.contentRoute` plus `ContentAccess.requireResource({ capability: 'export',
    resourceClass: 'campaign' })`, so the inventory and the guard both cover them.
  - A job is resolved for its requesting user only, then the current role is re-decided on every
    call.
  - The file streams `application/zip` with `no-store` and `nosniff`. Bytes are released on
    `finish` or at expiry.
- `apps/api/src/modules/sync/sync-rules.ts`: the `campaign` policy gains `export` for `owner` and
  `gm` only (the feature 04 decision path).
- `apps/api/src/runtime.ts`: wiring, the file sweep, the 30-day retention loop
  (`exportRetentionIntervalMs`, default 1 h), and the close hooks.
- `packages/attachments/src/reconciliation.ts`: the `RetainedAttachmentReferences.referenced` port
  now receives `{id, campaignId}`. Its test is updated.

### Tests

- **`apps/api/src/campaign-export.integration.test.ts`** (3 tests; runtime, HTTP, PostgreSQL):
  - *Player denial:* `assistant_gm`, `player` and non-member get the byte-identical safe 404 with
    no job row; anonymous gets 401; an unacknowledged warning gets 400.
  - *Owner and GM:* one package, with the exact pins, `content` excluded, and the exporter's
    display name.
  - *Attachments:* manifest only, with `gm_only` and `players` Visibility as stored.
  - *Leakage:* no password, session token, object key, signed URL, `audit_`, `identity_` or
    `"email"` field, and no non-target member id.
  - *Job metadata:* the job row holds only state, checksum, summary and requester.
  - *Delivery:* bytes are gone after delivery (410), and `fileAvailableUntil` clears.
  - *Scoping:* status and file are visible only to the requesting user; the owner cannot read a
    GM's job.
  - *Job ids:* reusing one across a user or campaign is refused; a retry returns the same job,
    with exactly one row.
  - *Demotion:* a GM demoted to player can no longer download or read status.
  - *Deleted campaign:* gets 404.
  - *Logs:* free of campaign content.
  - *Duration:* typical fixture, 200 finalized attachments, generate and download in 187 ms,
    82,831 bytes. Measured on the dev machine; the target is under 60 s.
- **`packages/campaign-portability/src/jobs.test.ts`** (5 tests): idempotent retry with no
  regeneration, conflicts, contributor failure (job failed with a safe code, no bytes held, no
  error text), delivery window, and the 30-day retention boundary.
- **`packages/campaign-portability/src/infra/postgres/export-jobs.integration.test.ts`**
  (2 tests): idempotent create, lifecycle, CHECK constraints (23514), active campaigns, and the
  exclusive 30-day boundary.
- **`packages/campaigns/src/export.test.ts`** (3 tests).
- **`apps/api/src/modules/portability/composition.test.ts`** (2 tests): contributor conformance
  and the retention seam.

## Notes and gaps

- The temporary file store is per process. A multi-instance deployment needs sticky routing or a
  shared temporary store. That is fine for P0 with a single API instance.
- The export runs synchronously inside the `POST`: a job goes from requested to running to
  completed within the request. Progress is the job state and summary; there is no streamed
  percentage.
- "Accepted profile": the duration was measured on the development machine against local Docker
  PostgreSQL. No other profile is documented.
