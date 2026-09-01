# Tasks: Campaign Import and Export

Source: `_prd.md`, `_bdd.md`, `_db.md`, and `_techspec.md`. P0 only.

| # | Task | Depends on | Status |
| --- | --- | --- | --- |
| 01 | [Ratify transaction-aware import contract](tasks/task_01.md) | feature 00 change process | pending |
| 02 | [Bounded rpgpack format and package inspector](tasks/task_02.md) | — | pending |
| 03 | [Export registry and consistent orchestrator](tasks/task_03.md) | 02 | pending |
| 04 | [Online export jobs, API, and download](tasks/task_04.md) | 03, feature 02/04 | pending |
| 05 | [Complete-replica offline export](tasks/task_05.md) | 03, feature 03 | pending |
| 06 | [Atomic import planner and coordinator](tasks/task_06.md) | 01–03, feature 01/02 contributors | pending |
| 07 | [Portability UI, fuzzing, and round-trip acceptance](tasks/task_07.md) | 04–06 | pending |

Binary attachments, audit export, selective restore, import preview counts, existing-campaign merge,
and public format guarantees remain deferred.

Completion gates: `bun run check`, `bun run typecheck`, `bun test`, `bun run guard`, `bun run build`.

