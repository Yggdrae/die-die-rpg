# Tasks: Fate Core System Package

Source: `_prd.md`, `_techspec.md`. P0 only.

| # | Task | Depends on | Status |
| --- | --- | --- | --- |
| 01 | [Package, tests, and installation](tasks/task_01.md) | features 08, 09, 10, 11 | completed |

Rules text, compendiums, guided creation, and localization are deferred. See `_techspec.md`.

Played against a saved character only once feature 15 supplies the target.

Completion gates: `bun run check`, `bun run typecheck`, `bun test --timeout 30000`, `bun run guard`, `bun run build`, `bun run test:e2e`.
