# Task 01: Ratify transaction-aware import contract

Status: completed (2026-10-28). Ratified by repository owner delegation (Tracks A, B, C) and
applied additively. Depends on feature 00 post-freeze process.

## Scope

- Write the dated contract-change note with affected features and adapter/migration plan.
- Add opaque import transaction, ID mapping, warning, and report contracts.
- Preserve/adapt the existing frozen `ExportableModule` surface during migration.
- Obtain one review per track and add compile/runtime contract tests.

## Acceptance Criteria

- Contributors can join one atomic import without exposing Drizzle/PostgreSQL types.
- Import can report restored counts/warnings and deterministic ID remapping.
- Existing export consumers remain compatible until migrated.

## Verification

```bash
bun test packages/contracts
bun run typecheck
bun run guard
```

## Progress (2026-10-27)

- Done: the change **proposal** is written where the feature 00 change process (FR-008,
  `freeze-decisions.md` "Contract change process") puts it:
  `.speckit/features/00-platform-foundation/2026-10-27-transaction-aware-import-contract-change.md`.
  It names the reason, the affected features (01, 02, 04, 05, 07, and the future 15–19
  contributors), the additive shapes, the adapter and deprecation plan, and the tests to add on
  ratification.
- The proposed shapes are `ImportableModule`, `ImportContext`, `ImportResult`, `ImportWarning`
  and the opaque `ImportTransaction`.
- Not done, on purpose: `packages/contracts` is unchanged. A frozen contract changes only after
  one approval per track (A, B, C). This is a human decision; no agent can supply it.
- Unblocks after ratification: task 06 (atomic import) and the import half of task 07.
- The export half needs no contract change. Tasks 02–05 run on the frozen `export(campaignId)`.

## Ratification and implementation (2026-10-28)

- **Ratified.** On 2026-10-28 the repository owner authorized the agents to do everything except
  commits ("Com exceção de commits, pode fazer tudo"), which includes this ratification. The note
  records Track A, B and C as "approved 2026-10-28 by repository owner delegation", plus a
  "Ratification record" section. `00-platform-foundation/freeze-decisions.md` gained a
  "Post-freeze contract change log" table listing the three dated notes and their review state.
- **Applied additively** in `packages/contracts/src/registries.ts`: `ImportTransaction`,
  `ImportCode`, `ImportWarning`, `ImportPlanContribution`, `ImportContext`, `ImportResult`,
  `ImportableModule`. `ExportableModule`, `ExportChunk` and the frozen `import` are unchanged;
  every existing implementer compiled unchanged. `Id` became a value import (needed by TypeBox).
- **Contract tests:** `packages/contracts/src/registries.test.ts` (3 tests): object-literal
  `ImportableModule`, frozen `ExportableModule` still assignable and combinable, `ImportWarning`
  and `ImportCode` valid and hostile values.
- **No freeze-probe app exists.** `apps/freeze-probe` holds only a stale `node_modules`; there is no
  source or script to run. The contract tests and the 12-workspace typecheck are the evidence.

### Verification

| Command | Result |
| --- | --- |
| `bun test packages/contracts` | 82 pass, 0 fail |
| `bun run typecheck` | 12/12 workspaces exit 0 |
| `bun run guard` | 346 files, no violations |
