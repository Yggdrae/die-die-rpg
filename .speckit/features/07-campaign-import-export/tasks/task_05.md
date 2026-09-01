# Task 05: Complete-replica offline export

Status: pending. Depends on task 03 and feature 03.

## Scope

- Implement browser worker export against one proven-complete replica cursor.
- Reuse format/contributor schemas without importing server persistence.
- Refuse incomplete replicas explicitly and produce manifest-only attachment entries.
- Test offline generation, restart-safe download, and parity with online logical counts/checksums.

## Acceptance Criteria

- Fully synchronized campaign exports with no network.
- Incomplete local data never becomes a silent partial backup.
- Offline package obeys the same secret/visibility/format rules as online export.

## Verification

```bash
bun test packages/campaign-portability apps/web/src/features/portability
bun run build
```

