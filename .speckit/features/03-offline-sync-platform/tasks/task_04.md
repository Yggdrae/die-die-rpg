# Task 04: PowerSync read path and authorized upload endpoint

Status: pending. Depends on tasks 01 and 03.

## Scope

- Add persistent sync-service configuration to the local stack and package adapter.
- Implement bootstrap and ordered mutation-batch Fastify routes with TypeBox.
- Register feature mutation appliers; reject arbitrary table/column operations.
- Test initial/incremental sync, reconnect, idempotency, and current-membership authorization.

## Acceptance Criteria

- Connected authority changes reach local SQLite without manual refresh.
- Offline queue drains in causal order and reports per-item outcomes.
- Revoked/unauthorized uploads fail closed regardless of cached role.

## Verification

```bash
bun test packages/sync apps/api/src/modules/sync
bun run typecheck
```

