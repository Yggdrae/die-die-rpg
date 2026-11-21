# Tasks: Dice Engine

Source: `_prd.md`, `_bdd.md`, `_techspec.md`, `_db.md`. P0 only.

| # | Task | Depends on | Status |
| --- | --- | --- | --- |
| 01 | [Parser and evaluator](tasks/task_01.md) | — | completed |
| 02 | [Record, policy, and device repository](tasks/task_02.md) | 01 | completed |
| 03 | [Table and authority service](tasks/task_03.md) | 02 | completed |
| 04 | [Applier, runtime, and streams](tasks/task_04.md) | 03 | completed |
| 05 | [Security acceptance](tasks/task_05.md) | 04 | completed |
| 06 | [Export and import](tasks/task_06.md) | 03 | completed |
| 07 | [Guard and gates](tasks/task_07.md) | 05, 06 | completed |

Exploding dice, rerolls, dice pool grouping, advantage, verified rolls, and macros are deferred (FR-101, FR-102, FR-103, FR-201, FR-202).

Completion gates: `bun run db:migrate`, `bun run check`, `bun run typecheck`, `bun test --timeout 30000`, `bun run guard`, `bun run build`, `bun run test:e2e`.
