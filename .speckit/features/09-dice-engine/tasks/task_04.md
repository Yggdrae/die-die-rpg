# Task 04: Applier, runtime, and streams

Status: completed (2026-10-31)

## Scope

- `apps/api/src/modules/dice/appliers.ts`; runtime registration; policy and binding in `sync-rules.ts`.
- YAML stream `authorized_rolls`; publication, replication, drift, truth-table, and simulated-replica tests.
- Web replica table.

## Acceptance Criteria

- BDD "Recording" outline and "Who receives a roll" pass through `POST /sync/mutations`.
- A tampered stream query is reported by the drift gate.

## Verification

```bash
bun test apps/api/src/modules/dice apps/api/src/modules/sync packages/sync/src/infra/postgres/publication.integration.test.ts
```
