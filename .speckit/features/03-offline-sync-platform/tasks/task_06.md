# Task 06: Single-writer long-text holds

Status: pending. Depends on tasks 03–04.

## Scope

- Implement acquire/renew/takeover/release routes and authority repository.
- Enforce 120-second expiry and 30-second active renewal.
- Add client primitives for held state, takeover notice, and unsaved local text preservation.
- Test concurrent acquire/takeover/expiry with database time.

## Acceptance Criteria

- At most one active hold exists per field.
- Previous holder cannot write after takeover and is notified.
- Expiry releases authority without deleting saved or unsaved local content.

## Verification

```bash
bun test packages/sync apps/api/src/modules/sync apps/web/src/features/sync
bun run typecheck
```

