# Tasks: Rules Library

Source: `_prd.md`, `_bdd.md`, `_techspec.md`, `_db.md`. P0 only.

| # | Task | Depends on | Status |
| --- | --- | --- | --- |
| 01 | [Quick rules contract and fixture rules tree](tasks/task_01.md) | feature 08 | completed |
| 02 | [Rules package: library model, search, marks](tasks/task_02.md) | 01, features 04, 20 | completed |
| 03 | [Marks authority, migration, and stream](tasks/task_03.md) | 02, features 03, 04 | completed |
| 04 | [Library screens, search contribution, shell](tasks/task_04.md) | 02, 03, features 18, 20 | completed |
| 05 | [Real-stack end-to-end](tasks/task_05.md) | 04 | completed |

P1 and P2 are deferred (D-18).

Completion gates: `bun run db:migrate`, `bun run check`, `bun run typecheck`, `bun test --timeout 30000`,
`bun run guard`, `bun run build`, `bun run test:e2e`.
