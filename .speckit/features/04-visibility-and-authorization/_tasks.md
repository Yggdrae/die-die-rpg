# Tasks: Visibility and Authorization

Source: `_prd.md`, `_bdd.md`, `_domain.md`, `_db.md`, and `_techspec.md`. P0 only.

| # | Task | Depends on | Status |
| --- | --- | --- | --- |
| 01 | [Pure decision engine and matrix test kit](tasks/task_01.md) | feature 01 Actor contract | completed |
| 02 | [Resource policy registry and author-private rule](tasks/task_02.md) | 01 | completed |
| 03 | [Versioned visibility mutation service](tasks/task_03.md) | 01–02 | completed |
| 04 | [Fastify enforcement and safe denial behavior](tasks/task_04.md) | 01–03, feature 01 resolver | completed |
| 05 | [Sync predicate compiler and equivalence suite](tasks/task_05.md) | 02, feature 03 | completed (provider round trip verified 2026-10-26) |
| 06 | [Reveal and un-reveal interface](tasks/task_06.md) | 03–04 | completed (provider round trip verified 2026-10-26; live per-row reveal awaits a content class) |
| 07 | [Authorization guard and security acceptance](tasks/task_07.md) | 04–06 | completed (attachment store/export not built; provider round trip verified 2026-10-26) |

Party targeting stays fail-closed/P1 until a party resolver exists. Custom roles are P2.

Completion gates: `bun run check`, `bun run typecheck`, `bun test`, `bun run guard`, `bun run build`.
