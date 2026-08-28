# Task 03: Durable mutation queue and SyncedRepository

Status: pending. Depends on task 02.

## Scope

- Implement bookkeeping tables, campaign sequencing, status store, and repository adapter.
- Atomically write local record, pending mutation, and audit envelope.
- Enforce stable mutation IDs, causal order, restart durability, and 10 MB pressure behavior.
- Run frozen repository conformance tests against the real adapter.

## Acceptance Criteria

- Local writes return without a server round trip and survive restart.
- Lost acknowledgements cannot double-apply a mutation.
- Capacity blocks new writes without evicting confirmed pending work.

## Verification

```bash
bun test packages/sync packages/contracts/src/testing
bun run typecheck
```

