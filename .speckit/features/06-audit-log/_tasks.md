# Tasks: Audit Log

Source: `_prd.md`, `_bdd.md`, `_db.md`, and `_techspec.md`. P0 only.

| # | Task | Depends on | Status |
| --- | --- | --- | --- |
| 01 | [Audit stores and renderer registry](tasks/task_01.md) | feature 04 declarations | pending |
| 02 | [Non-blocking recorder and mutation envelope](tasks/task_02.md) | 01, feature 03 envelope | pending |
| 03 | [Authorized audit query API](tasks/task_03.md) | 01–02, feature 04 | pending |
| 04 | [Separate synchronization and local compaction](tasks/task_04.md) | 01–03, feature 03 | pending |
| 05 | [Campaign and session audit interface](tasks/task_05.md) | 03–04 | pending |
| 06 | [Contributor conformance, retention, and acceptance](tasks/task_06.md) | 02–05 | pending |

Export, grouping, archival, undo, and tamper evidence remain deferred. Server deletion stays report-only
until the proposed 365-day retention receives product approval.

Completion gates: `bun run check`, `bun run typecheck`, `bun test`, `bun run guard`, `bun run build`.

