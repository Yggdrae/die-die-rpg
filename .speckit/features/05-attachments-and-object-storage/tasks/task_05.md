# Task 05: Offline attachment store and campaign pinning

Status: pending. Depends on task 04 and feature 03.

## Scope

- Implement device-local state/byte store, atomic verified download, cache vs pin semantics.
- Add campaign estimate/confirmation/progress UI with bounded download concurrency.
- Handle restart, interruption, unavailable state, visibility removal, membership revocation, and sign-out.
- Test exact payload estimate tolerance and no duplicate unchanged bytes.

## Acceptance Criteria

- Nothing downloads before explicit confirmation.
- Every reported pinned attachment opens offline after restart.
- Revocation removes local metadata/bytes on observed synchronization and aborts downloads.

## Verification

```bash
bun test packages/attachments apps/web/src/features/attachments
bun run build
```

