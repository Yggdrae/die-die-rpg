# Tasks: Handouts and Reveal

Source: `_prd.md`, `_bdd.md`, `_techspec.md`, `_db.md`. P0 only.

| # | Task | Depends on | Status |
| --- | --- | --- | --- |
| 01 | [Handout type and attachments that follow it](tasks/task_01.md) | feature 16 | completed |
| 02 | [Queued reveal at the authority](tasks/task_02.md) | 01, features 03, 04, 06 | completed |
| 03 | [Device reveal and the handout screen](tasks/task_03.md) | 01, 02 | completed |
| 04 | [Live sync and real-stack end-to-end](tasks/task_04.md) | 02, 03 | completed |

Read receipts, staged and partial reveals (P1), editable handouts, knowledge reveals, and realtime effects (P2) are
deferred. Party targeting waits for feature 04's party resolver. See `_techspec.md`.

Completion gates: `bun run check`, `bun run typecheck`, `bun test --timeout 30000`, `bun run guard`, `bun run build`,
`bun run test:e2e`.
