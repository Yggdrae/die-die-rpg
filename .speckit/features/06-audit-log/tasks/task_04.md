# Task 04: Separate synchronization and local compaction

Status: pending. Depends on tasks 01–03 and feature 03.

## Scope

- Register independent campaign/private sync rules and local tables.
- Merge pending local and accepted authority order honestly.
- Implement 10 MB compaction preserving pending and newest 90-day history.
- Test player database absence, revoked membership cleanup, and partial-history marker.

## Acceptance Criteria

- Player replicas cannot address or contain private rows/table metadata.
- Hidden events/counts/tombstones never arrive.
- Compaction never evicts pending events or moves rows between stores.

## Verification

```bash
bun test packages/audit packages/sync
bun run typecheck
```

