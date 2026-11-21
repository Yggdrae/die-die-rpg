# Task 05: Applier, audit, streams

Status: completed (2026-11-01)

## Scope

- Applier, runtime, audit declarations and facts source, policy and binding, YAML, publication, drift, truth-table, simulated-replica, and live tests.

## Acceptance Criteria

- BDD "Offline and Concurrency" and "Atomicity, Authorization, Audit" pass through `POST /sync/mutations`.
- Zero hidden records on a player replica, not skipped.

## Verification

```bash
bun test apps/api/src/modules/actions apps/api/src/modules/sync
```
