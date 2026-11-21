# Tasks: Session Mode

Source: `_prd.md`, `_bdd.md`, `_techspec.md`, `_db.md`. P0 only.

| # | Task | Depends on | Status |
| --- | --- | --- | --- |
| 01 | [Records, model, policies, and persistence](tasks/task_01.md) | features 03, 04, 15, 16 | completed |
| 02 | [Authority service, appliers, sync stream, and audit](tasks/task_02.md) | 01, feature 06 | completed |
| 03 | [Export and import contributor](tasks/task_03.md) | 02, feature 07 | completed |
| 04 | [Session screen, player view, and command palette](tasks/task_04.md) | 01, 02 | completed |
| 05 | [Live sync and real-stack end-to-end](tasks/task_05.md) | 04 | completed |

Preparation, recap, rules panel (P1), clocks, presence, and collaborative notes (P2) are deferred. See `_techspec.md`.

Completion gates: `bun run db:migrate`, `bun run check`, `bun run typecheck`, `bun test --timeout 30000`,
`bun run guard`, `bun run build`, `bun run test:e2e`.
