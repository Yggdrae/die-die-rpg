# Task 02: SQLite worker, OPFS persistence, and fallback

Status: pending.

## Scope

- Create `packages/sync` worker RPC and local migration runner.
- Serve pinned sqlite-wasm assets without Vite rewriting and add COOP/COEP headers.
- Implement OPFS primary and forced IndexedDB-backed fallback.
- Test persistence/recovery across browser restart and failed migration.

## Acceptance Criteria

- All SQLite work runs off the main thread.
- Both persistence backends reopen the same fixture campaign after restart.
- A local migration cannot partially upgrade or discard pending mutations.

## Verification

```bash
bun test packages/sync
bun run build
```

