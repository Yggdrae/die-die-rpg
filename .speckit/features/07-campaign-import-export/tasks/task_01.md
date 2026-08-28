# Task 01: Ratify transaction-aware import contract

Status: pending. Depends on feature 00 post-freeze process.

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

