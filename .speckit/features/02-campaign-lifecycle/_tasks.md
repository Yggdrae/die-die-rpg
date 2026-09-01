# Tasks: Campaign Lifecycle

Source: `_prd.md`, `_bdd.md`, `_db.md`, and `_techspec.md`. P0 only.

| # | Task | Depends on | Status |
| --- | --- | --- | --- |
| 01 | [Public campaign contracts and manifest-driven rules](tasks/task_01.md) | feature 08 contract or approved fixture | completed |
| 02 | [Campaign PostgreSQL schema and owner invariant](tasks/task_02.md) | 01, feature 01 membership schema | pending |
| 03 | [Campaign application services and context resolver](tasks/task_03.md) | 01, 02 | completed |
| 04 | [Fastify campaign API](tasks/task_04.md) | 03, feature 04 decision API | completed |
| 05 | [Creation wizard and campaign list](tasks/task_05.md) | 01, 04 | completed |
| 06 | [Offline creation and synchronized campaign repository](tasks/task_06.md) | 03, feature 03 repository | pending |
| 07 | [Explicit system-version update flow](tasks/task_07.md) | 03, 04, feature 08 exact-version resolver | completed |
| 08 | [Campaign boundary guard and acceptance flows](tasks/task_08.md) | 04–07 | pending |

P1 filters, cover identity, and post-creation mode changes are deferred. P0 module pins are immutable.

Completion gates: `bun run check`, `bun run typecheck`, `bun test`, `bun run guard`, `bun run build`.
