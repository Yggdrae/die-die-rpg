# Task 05: Guard rule and bundle check

Status: completed (2026-10-31)

## Scope

- `no-impure-engine-imports` guard rule with fixtures.
- `tools/guard/src/bundle-check.ts` with tests; last step of web and API `build`.
- Browser determinism vectors in `apps/web/e2e/determinism.e2e.ts`.

## Acceptance Criteria

- A planted `new Function` in a scanned file fails the check; the web bundle has zero occurrences; `@rpg/formula` bundled alone has zero.
- Browser results equal the table.

## Verification

```bash
bun run guard
bun run build
bun x playwright test apps/web/e2e/determinism.e2e.ts
```
