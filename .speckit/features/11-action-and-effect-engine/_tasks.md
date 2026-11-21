# Tasks: Action and Effect Engine

Source: `_prd.md`, `_bdd.md`, `_domain.md`, `_techspec.md`, `_db.md`. P0 only.

| # | Task | Depends on | Status |
| --- | --- | --- | --- |
| 01 | [Contract additions and effect validation](tasks/task_01.md) | — | completed |
| 02 | [Target state, operations, guards, overlay](tasks/task_02.md) | — | completed |
| 03 | [Planning pipeline and every kind](tasks/task_03.md) | 01, 02 | completed |
| 04 | [Ledger, service, and adapter port](tasks/task_04.md) | 02 | completed |
| 05 | [Applier, audit, streams](tasks/task_05.md) | 04 | completed |
| 06 | [Browser composition, guard, gates](tasks/task_06.md) | 05 | completed |

Durations, multi-target, suggestions, interception, and reversal are deferred (FR-101, FR-102, FR-103, FR-201, FR-202).

No target adapter ships here (D-13): characters arrive with feature 15, and a production upload is refused with `unknown_target` until then.

Completion gates: `bun run db:migrate`, `bun run check`, `bun run typecheck`, `bun test --timeout 30000`, `bun run guard`, `bun run build`, `bun run test:e2e`.
