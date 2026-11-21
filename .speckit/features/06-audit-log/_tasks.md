# Tasks: Audit Log

Source: `_prd.md`, `_bdd.md`, `_db.md`, and `_techspec.md`. P0 only.

| # | Task | Depends on | Status |
| --- | --- | --- | --- |
| 01 | [Audit stores and renderer registry](tasks/task_01.md) | feature 04 declarations | completed; undescribed targets resolve from feature 04 declarations, else fail-closed GM-only |
| 02 | [Non-blocking recorder and mutation envelope](tasks/task_02.md) | 01, feature 03 envelope | completed; recorder/retry/dead-letter, sync mutation envelope (origin ID = mutation ID), and in-transaction authority audit for campaign appliers (after-commit only as fallback/replay repair) |
| 03 | [Authorized audit query API](tasks/task_03.md) | 01–02, feature 04 | completed; campaign/session/private routes decide each event on the target's current feature 04 facts plus its stored snapshot before rows, totals, cursors and rendering; undeclared classes fail closed; membership events are readable by GM roles only (reader rule Approved (2026-10-28, delegated by owner)) |
| 04 | [Separate synchronization and local compaction](tasks/task_04.md) | 01–03, feature 03 | completed; two explicitly-subscribed streams compiled from declarations (current target, snapshot, private GM narrowing), player replicas never hold or address the private store, month-window compaction (90 days, 10 MB), merged pending/accepted reads; only campaign-scoped targets replicate (provider limit), others online-only |
| 05 | [Campaign and session audit interface](tasks/task_05.md) | 03–04 | completed; campaign/session log with private tab as GM hint, filters, cursor and invalid-cursor restart, pending/partial markers; 7 Playwright tests |
| 06 | [Contributor conformance, retention, and acceptance](tasks/task_06.md) | 02–05 | completed; FR-005 inventory with CI scan, contributor renderers registered, acceptance through the runtime; 365-day retention Approved (2026-10-28, delegated by owner); replicas acknowledge synced audit rows through the feature 03 ack route; deletion executor off unless `AUDIT_RETENTION_DELETE=true` |

Export, grouping, archival, undo, and tamper evidence remain deferred. Server deletion (365 days, approved
2026-10-28) stays report-only unless an operator sets `AUDIT_RETENTION_DELETE=true`.

Completion gates: `bun run check`, `bun run typecheck`, `bun test`, `bun run guard`, `bun run build`.

