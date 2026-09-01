# Task 04: Online export jobs, API, and download

Status: pending. Depends on task 03 and feature 02/04 boundaries.

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

