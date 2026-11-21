# Tasks: Dynamic Character Sheet

Source: `_prd.md`, `_bdd.md`, `_techspec.md`, `_db.md`. P0 only.

| # | Task | Depends on | Status |
| --- | --- | --- | --- |
| 01 | [Sheet model and edit plans](tasks/task_01.md) | features 08, 10, 11 | completed |
| 02 | [Persistence, policies, and sync streams](tasks/task_02.md) | 01, features 03, 04 | completed |
| 03 | [Authority service, applier, and effect target](tasks/task_03.md) | 02, feature 11 | completed |
| 04 | [Audit, export, import, and search contributors](tasks/task_04.md) | 03, features 06, 07 | completed |
| 05 | [Sheet, actions, and workspace screens](tasks/task_05.md) | 01, 03 | completed |
| 06 | [Real-stack end-to-end](tasks/task_06.md) | 05 | completed |

Guided creation, layouts, portraits, advancement, and printing are deferred. See `_techspec.md`.

Completion gates: `bun run db:migrate`, `bun run check`, `bun run typecheck`, `bun test --timeout 30000`,
`bun run guard`, `bun run build`, `bun run test:e2e`.
