# Tasks: Campaign Content and Entities

Status: approved 2026-10-28 (decisions delegated by owner); ready for execution.

Source: `_prd.md`, `_bdd.md`, `_db.md`, and `_techspec.md`. P0 only. `D-NN` = product decision
(all decided 2026-10-28, `_techspec.md` "Decisions") and `B-N` = cross-feature blocker (resolution
plans in `_techspec.md` "Cross-Feature Blocker Resolutions"). B-1, B-2, B-3 are additive changes
folded into tasks 08, 06, 04; B-4 is designed around in task 12; B-5 gated task 17 only and is resolved.

| # | Task | Depends on | Blocked by | Status |
| --- | --- | --- | --- | --- |
| 01 | [Type configuration and pure content rules](tasks/task_01.md) | — | — | completed (2026-10-28) |
| 02 | [Entity and personal-note tables](tasks/task_02.md) | 01 | — | completed (2026-10-28) |
| 03 | [Resource policies, adapter, facts source, conformance](tasks/task_03.md) | 02 | — | completed (2026-10-28) |
| 04 | [Content sync streams, hold filters (B-3), drift gate](tasks/task_04.md) | 03 | — | completed (2026-10-28) |
| 05 | [Content services and audit declarations](tasks/task_05.md) | 03 | — | completed (2026-10-29) |
| 06 | [Sync mutation appliers for entities and notes (B-2)](tasks/task_06.md) | 04, 05 | — | completed (2026-10-29) |
| 07 | [Read-only content routes](tasks/task_07.md) | 05 | — | completed (2026-10-29) |
| 08 | [Relationship persistence, policy, visibility bound (B-1)](tasks/task_08.md) | 03, 04 | — | completed (2026-10-29) |
| 09 | [Relationship mutations and endpoint narrowing](tasks/task_09.md) | 06, 08 | — | completed (2026-10-29) |
| 10 | [Published entity directory API](tasks/task_10.md) | 05, 08 | — | completed (2026-10-30) |
| 11 | [Web entity list, filters, and detail](tasks/task_11.md) | 04, 07 | — | completed (2026-10-30) |
| 12 | [Web quick create, editor, holds, visibility controls, session quick actions](tasks/task_12.md) | 06, 11 | — | completed (2026-10-30) |
| 13 | [Web relationships and attachment panel](tasks/task_13.md) | 09, 12 | — | completed (2026-10-30) |
| 14 | [Custom fields editor](tasks/task_14.md) | 06, 12 | — | completed (2026-10-30) |
| 15 | [Export and search contributors](tasks/task_15.md) | 05, 08 | — | completed (2026-10-30); search indexer not called at runtime (feature 20 has no code) |
| 16 | [Content security and product acceptance](tasks/task_16.md) | 04–15 | — | completed (2026-10-30): manual 30 s measurement replaced by an automated test, owner decision |
| 17 | [Content import contributor](tasks/task_17.md) | 15 | B-5 resolved (note ratified 2026-10-28, feature 07 task 06 landed) | completed (2026-10-30) |

Changes from the draft: custom-field rules moved into task 01 (pure rule) and task 06 (authority),
leaving task 14 as the editor; relationship kinds moved from task 08 to task 01; the import half of
task 15 split out as task 17; task 13's feature 05 blocker removed (feature 05 complete).

Deferred: creature statistics (FR-101, D-03), bulk operations (FR-102), templates (FR-103),
relationship browsing view (FR-104), Markdown rendering (D-10), attachments and links on personal
notes (D-15), Session Mode placement of the quick actions (feature 18, D-14), all P2 items.

Completion gates: `bun run check`, `bun run typecheck`, `bun test`, `bun run guard`, `bun run build`.
