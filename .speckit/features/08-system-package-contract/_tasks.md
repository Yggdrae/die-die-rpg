# Tasks: System Package Contract and Registry

Source: `_prd.md`, `_bdd.md`, `_techspec.md`. P0 only.

| # | Task | Depends on | Status |
| --- | --- | --- | --- |
| 01 | [Closed capability registry](tasks/task_01.md) | — | completed |
| 02 | [Package schemas and plain-data guard](tasks/task_02.md) | 01 | completed |
| 03 | [Semantic validation](tasks/task_03.md) | 02 | completed |
| 04 | [System registry and summary projection](tasks/task_04.md) | 03 | completed |
| 05 | [Conformance kit and two-paradigm proof](tasks/task_05.md) | 04 | completed |
| 06 | [Campaign and fixture migration](tasks/task_06.md) | 05 | completed |
| 07 | [Boundary guard, ADRs, and gates](tasks/task_07.md) | 06 | completed |

Compendium content, changelog, translation metadata, signing, and executable plugins are deferred.

Completion gates: `bun run check`, `bun run typecheck`, `bun test`, `bun run guard`, `bun run build`.
