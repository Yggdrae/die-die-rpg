# Task 07: Explicit system-version update flow

Status: completed. Verified against the exact-version fixture catalog adapter.

## Scope

- Implement availability/review and owner-confirmed pin update use cases/routes/UI.
- Block missing targets and incompatible option declarations without dropping values.
- Enforce expected campaign version and audit accepted changes.
- Test keep-current, no-auto-update, concurrency, and unavailable pin failures.

## Acceptance Criteria

- Installing a newer system never changes a campaign automatically.
- Exactly one concurrent update wins; the other receives explicit conflict.
- Every context read returns the exact committed pin or fails closed.

## Verification

```bash
bun test packages/campaigns apps/api/src/modules/campaigns apps/web/src/features/campaigns
bun run typecheck
```
