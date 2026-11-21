# Task 04: Load integration and composition

Status: completed (2026-10-31)

## Scope

- `packages/systems`: `formulaCycles` port, `formula_cycle` code, `runConformance(candidate, validators?)`, paradigm export.
- `apps/api/src/modules/systems/registry.ts`: registry built with the engines; runtime default catalog through it.

## Acceptance Criteria

- BDD "At Package Load" passes with the real engines (dice validator from feature 09 included).
- `@rpg/systems` still imports neither engine, asserted by the guard.

## Verification

```bash
bun test packages/systems apps/api/src/modules/systems
```
