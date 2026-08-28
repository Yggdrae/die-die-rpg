# Task 01: Ratify revocation and replica-purge contract

Status: pending. Depends on feature 00 post-freeze process.

## Scope

- Write the dated contract-change note naming affected features and migration.
- Add the smallest provider-neutral membership-revocation/replica-purge boundary.
- Define acknowledgment/watermark types without exposing PowerSync.
- Obtain one review per track and add contract tests.

## Acceptance Criteria

- Feature 01 can revoke access without importing feature 03.
- Feature 03 can prove when a tombstone is safe to purge.
- Existing frozen repository consumers remain source-compatible.

## Verification

```bash
bun test packages/contracts
bun run typecheck
bun run guard
```

