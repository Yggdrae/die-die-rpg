# Task 01: Audit stores and renderer registry

Status: pending. Depends on feature 04 declaration boundary.

## Scope

- Create `packages/audit`, two independent schemas/migrations, sequence allocator, privileges, and guard triggers.
- Implement campaign/private repositories with no shared broad read method.
- Add payload/renderer registry keyed by action/version and safe generic fallback.
- Test routing, immutability, idempotency, sequence concurrency, and renderer safety.

## Acceptance Criteria

- `private` routes one event to exactly one physical table.
- Application roles cannot update/delete history.
- Client clocks cannot alter stable campaign order.

## Verification

```bash
bun test packages/audit
bun run typecheck
```

