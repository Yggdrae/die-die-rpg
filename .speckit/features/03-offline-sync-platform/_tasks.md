# Tasks: Offline-First Sync Platform

Source: `_prd.md`, `_bdd.md`, `_domain.md`, `_db.md`, and `_techspec.md`. P0 only.

| # | Task | Depends on | Status |
| --- | --- | --- | --- |
| 01 | [Ratify revocation and replica-purge contract](tasks/task_01.md) | feature 00 change process | pending |
| 02 | [SQLite worker, OPFS persistence, and fallback](tasks/task_02.md) | — | pending |
| 03 | [Durable mutation queue and SyncedRepository](tasks/task_03.md) | 02 | pending |
| 04 | [PowerSync read path and authorized upload endpoint](tasks/task_04.md) | 01, 03 | pending |
| 05 | [Deferred conflicts and semantic operations](tasks/task_05.md) | 03–04 | pending |
| 06 | [Single-writer long-text holds](tasks/task_06.md) | 03–04 | pending |
| 07 | [Visibility rules, revocation, and tombstone watermarks](tasks/task_07.md) | 01, 04, feature 04 | pending |
| 08 | [Sync status, browser acceptance, and performance](tasks/task_08.md) | 02–07 | pending |

Completion gates: `bun run check`, `bun run typecheck`, `bun test`, `bun run guard`, `bun run build`.

