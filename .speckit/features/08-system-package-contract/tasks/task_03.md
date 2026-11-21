# Task 03: Semantic validation

Status: completed (2026-10-30)

## Scope

- `semantics.ts`: unique keys, references, defaults within constraints, `min <= max`, ladder order, capability
  honesty both ways (D-06), licence contradictions (D-08).
- `load.ts`: `loadSystemPackage(candidate, validators?)` in the techspec's order, deep-freezing the result.
- `ExpressionValidators` port (D-07), exercised with a stand-in.

## Acceptance Criteria

- Every row of BDD "An invalid package is rejected whole" has a test asserting code and path.
- All errors are reported, not only the first.
- A rejected expression from a validator rejects the package; without validators expressions stay inert text.
- The served package is frozen at every depth.

## Verification

```bash
bun test packages/systems
```
