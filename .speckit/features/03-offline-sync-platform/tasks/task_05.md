# Task 05: Deferred conflicts and semantic operations

Status: completed. Verified with durable conflict, semantic-operation, and shared UI tests.

## Scope

- Persist immediate/deferred conflicts with both submitted/current values.
- Emit frozen `ConflictChannel` events and implement durable resolution mutations.
- Implement idempotent delta/set/clamp authority handlers.
- Add shared React conflict surface with defer/resubmit/authority/manual-merge options.

## Acceptance Criteria

- No rejected confirmed mutation disappears or silently reverts local state.
- Concurrent deltas merge exactly once; absolute sets conflict.
- Conflict resolution is explicit and itself versioned.

## Verification

```bash
bun test packages/sync apps/web/src/features/sync
bun run typecheck
```
