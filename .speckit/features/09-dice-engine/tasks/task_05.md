# Task 05: Security acceptance

Status: completed (2026-10-31)

## Scope

- Real composition root with every requester; live PowerSync test: exact rows, zero hidden, no churn.
- Browser e2e: offline roll, exactly once, player replica holds zero hidden rolls; determinism vectors.

## Acceptance Criteria

- Zero hidden rolls on a player replica, asserted on stored rows, not skipped.

## Verification

```bash
bun test apps/api/src/modules/sync/sync-config.powersync.integration.test.ts
bun x playwright test apps/web/e2e/dice.e2e.ts apps/web/e2e/determinism.e2e.ts
```
