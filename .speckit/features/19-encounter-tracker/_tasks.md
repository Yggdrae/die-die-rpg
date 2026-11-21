# Tasks: Encounter Tracker

Source: `_prd.md`, `_bdd.md`, `_techspec.md`, `_db.md`. P0 only.

| # | Task | Depends on | Status |
| --- | --- | --- | --- |
| 01 | [Records, model, policies, and persistence](tasks/task_01.md) | features 03, 04, 11, 15, 16 | completed |
| 02 | [Authority service, appliers, target adapter, sync stream, and audit](tasks/task_02.md) | 01, features 06, 11 | completed |
| 03 | [Export and import contributor](tasks/task_03.md) | 02, feature 07 | completed |
| 04 | [Tracker, start form, player view, and Session Mode quick action](tasks/task_04.md) | 01, 02, feature 18 | completed |
| 05 | [Live sync and real-stack end-to-end](tasks/task_05.md) | 04 | completed |

Turn order, templates, group actions (P1) and P2 are deferred. See `_techspec.md`.

Completion gates: `bun run db:migrate`, `bun run check`, `bun run typecheck`, `bun test --timeout 30000`,
`bun run guard`, `bun run build`, `bun run test:e2e`.
