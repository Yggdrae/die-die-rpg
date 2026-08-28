# Task 05: Sync predicate compiler and equivalence suite

Status: pending. Depends on task 02 and feature 03 sync adapter.

## Scope

- Define provider-neutral predicate AST and compile registered policies.
- Implement the initial provider adapter in feature 03.
- Run exhaustive API-vs-sync truth-table tests for roles, targets, ownership, deletion, and campaigns.
- Test reveal delivery, un-reveal removal, and absence of unseen tombstones.

## Acceptance Criteria

- Any application/sync outcome divergence fails CI.
- Hidden/player-private rows never reach unauthorized local databases.
- Party predicates deny until a resolver registers.

## Verification

```bash
bun test packages/authorization packages/sync
bun run typecheck
```

