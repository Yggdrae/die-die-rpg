# Task 07: Boundary guard, ADRs, and gates

Status: completed (2026-10-30)

## Scope

- Guard rule: `packages/systems` imports no persistence, UI, or Node API; test fixtures for the rule.
- Source scan test: no `eval`, `new Function`, or dynamic `import(` in `packages/systems/src`.
- ADRs: declarative-only packages; capability flags versus system identity checks.

## Acceptance Criteria

- Each guard rule fails on its violating fixture.
- Full gates pass.

## Verification

```bash
bun run check
bun run typecheck
bun test --timeout 30000
bun run guard
bun run build
bun run test:e2e
```
