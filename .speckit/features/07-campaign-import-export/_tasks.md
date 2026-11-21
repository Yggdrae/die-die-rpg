# Tasks: Campaign Import and Export

Source: `_prd.md`, `_bdd.md`, `_db.md`, and `_techspec.md`. P0 only.

| # | Task | Depends on | Status |
| --- | --- | --- | --- |
| 01 | [Ratify transaction-aware import contract](tasks/task_01.md) | feature 00 change process | completed (ratified 2026-10-28 by repository owner delegation, A/B/C; applied additively in `registries.ts`) |
| 02 | [Bounded rpgpack format and package inspector](tasks/task_02.md) | — | completed |
| 03 | [Export registry and consistent orchestrator](tasks/task_03.md) | 02 | completed |
| 04 | [Online export jobs, API, and download](tasks/task_04.md) | 03, feature 02/04 | completed (migration `0009_export_jobs`) |
| 05 | [Complete-replica offline export](tasks/task_05.md) | 03, feature 03 | completed (2026-10-31): a fully synchronized campaign exports offline with the online chunks, Chromium engines verified; restart-safe store and dedicated worker replaced by recorded decisions |
| 06 | [Atomic import planner and coordinator](tasks/task_06.md) | 01–03, feature 01/02 contributors | completed (migration `0010_import_jobs`) |
| 07 | [Portability UI, fuzzing, and round-trip acceptance](tasks/task_07.md) | 04–06 | completed (export UI and import UI, round trip on runtime and in the browser, fuzzing, rollback, guard) |

Binary attachments (and therefore attachment rows on import), audit export, selective restore,
import preview counts, existing-campaign merge, an approved member-mapping flow, and public format
guarantees remain deferred.

Completion gates: `bun run check`, `bun run typecheck`, `bun test`, `bun run guard`, `bun run build`.

