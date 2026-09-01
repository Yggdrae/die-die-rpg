# Task 01: Verify S3 adapter, MinIO, and browser isolation

Status: pending.

## Scope

- Evaluate the smallest maintained S3-compatible client/presigner under pinned Bun.
- Verify MinIO startup, private bucket bootstrap, bound upload/read grants, expiry, checksum support, and CORS.
- Verify image/PDF delivery preserves feature 03 COOP/COEP requirements and separate-origin safety.
- Record evidence and exact supported configuration; do not retain throwaway spike code.

## Acceptance Criteria

- One adapter choice is evidenced under Bun/MinIO with no provider type in domain contracts.
- Uploaded active content cannot execute in the application origin.
- Any unsupported grant condition is documented and compensated at finalization.

## Verification

```bash
bun test packages/attachments
bun run build
```

