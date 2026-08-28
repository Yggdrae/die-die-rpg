# Task 06: Offline creation and synchronized campaign repository

Status: pending. Depends on task 03 and feature 03 repository.

## Scope

- Implement campaign/settings local schemas and `SyncedRepository` adapters.
- Record the creation aggregate atomically with stable client IDs and causal upload grouping.
- Queue invitations only after campaign acceptance; never report offline invitations delivered.
- Test restart durability, reconnect idempotency, conflict, and tombstone behavior.

## Acceptance Criteria

- Offline-created campaign is immediately readable and converges with identical IDs/pins.
- No partial aggregate reaches authority or survives a rejected creation.
- Membership revocation/campaign deletion removes local context.

## Verification

```bash
bun test packages/campaigns packages/sync
bun run typecheck
```

