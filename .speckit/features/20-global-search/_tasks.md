# Tasks: Global Search

Source: `_prd.md`, `_bdd.md`, `_techspec.md`. P0 only. No `_db.md`: the index is derived and in memory (D-02).

| # | Task | Depends on | Status |
| --- | --- | --- | --- |
| 01 | [Search package and guard rule](tasks/task_01.md) | feature 00 | completed |
| 02 | [Contributors, visibility predicate, and routes](tasks/task_02.md) | 01, features 04, 15, 16, 19 | completed |
| 03 | [Search service, screen, and palette provider](tasks/task_03.md) | 01, 02, feature 18 | completed |
| 04 | [Real-stack end-to-end](tasks/task_04.md) | 03 | completed |

Type filters, recent results, tags (P1) and P2 are deferred.

Completion gates: `bun run db:migrate`, `bun run check`, `bun run typecheck`, `bun test --timeout 30000`,
`bun run guard`, `bun run build`, `bun run test:e2e`.
