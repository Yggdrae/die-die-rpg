# Tasks: Formula Engine

Source: `_prd.md`, `_bdd.md`, `_techspec.md`. P0 only.

| # | Task | Depends on | Status |
| --- | --- | --- | --- |
| 01 | [Parser and AST](tasks/task_01.md) | — | completed |
| 02 | [Validator and interpreter](tasks/task_02.md) | 01 | completed |
| 03 | [Dependencies, cycles, adversarial corpus, determinism](tasks/task_03.md) | 02 | completed |
| 04 | [Load integration and composition](tasks/task_04.md) | 03 | completed |
| 05 | [Guard rule and bundle check](tasks/task_05.md) | 03 | completed |

Additional functions, conditionals, isolated runtimes, and an authoring surface are deferred (FR-101, FR-102, FR-201, FR-202).

Completion gates: `bun run check`, `bun run typecheck`, `bun test`, `bun run guard`, `bun run build`, `bun run test:e2e`.
