# Task 05: In-Memory SyncedRepository Double

## Goal

An in-memory implementation of `SyncedRepository` that lets every wave 1 and wave 2 feature build
and test before feature 03 exists.

## Dependencies

- Task 04

## Context

- TechSpec: `../_techspec.md` (Local reference implementation)
- `../_index.md`, wave plan: features built in waves 1 and 2 run against this double; feature 03
  swaps the implementation without those features changing.
- This is a development and test double, not a product path.

## Scope

### Change

- In-memory `SyncedRepository` implementation in `packages/contracts`.
- Version increment on successful `upsert`.
- Typed conflict result when `expectedVersion` does not match current.
- Tombstone behavior on `softDelete`: the record remains, `deletedAt` is set, and it is excluded
  from `list` by default.
- Tests focused on the conflict and tombstone paths.

### Do Not Change

- No persistence across process restart. No file, no database, no network.
- No sync, no queue, no reconnect. Feature 03 owns all of it.
- Do not let this grow into a local-first implementation. If it starts to look like feature 03,
  stop and hand it to feature 03.

## Acceptance Criteria

- [ ] `upsert` with a matching `expectedVersion` succeeds and increments `version` by one.
- [ ] `upsert` with a stale `expectedVersion` returns the typed conflict failure and does not
      mutate stored state.
- [ ] `softDelete` sets `deletedAt` and the record no longer appears in a default `list`.
- [ ] Concurrent `upsert` against the same version: exactly one succeeds, one conflicts.
- [ ] Documented in the package as a test double, with a pointer to feature 03 as the real one.

## Verification

```bash
bun test packages/contracts && bun run typecheck
```

## Notes

- Divergence between this double and feature 03 is a real risk: if the double is more permissive,
  waves 1 and 2 build against behavior that does not exist. The conflict path is where that would
  hurt, which is why it carries the test weight.
- Feature 03 should run this same test suite against its real implementation. Keep the tests
  reusable rather than tied to the in-memory internals.
