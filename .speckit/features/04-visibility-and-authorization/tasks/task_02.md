# Task 02: Resource policy registry and author-private rule

Status: completed. Depends on task 01.

## Scope

- Implement startup registry validation for policies, adapters, defaults, and sync predicates.
- Add ownership-predicate support and the author-private note conformance fixture.
- Reject duplicate/incomplete declarations and inactive party targeting.
- Publish the registration/test-kit entry points without owner internals.

## Acceptance Criteria

- A player-authored private note denies every non-author, including GM roles.
- Missing capability rows prevent registration instead of defaulting allow.
- No frozen `Visibility` contract change is needed.

## Verification

```bash
bun test packages/authorization
bun run guard
```

## Evidence

- `bun test packages/authorization`: 27 pass, 0 fail (285 expects) across
  `authorization.test.ts`, `registry.test.ts`, `test-kit.test.ts`.
- `bun run typecheck`: all 10 workspaces exit 0.
- `bun run guard`: 174 files checked, no violations.
- `bun run check`: 210 files, no fixes.
- `bun test apps/api packages/sync` (DB env loaded): 166 pass, 0 fail — the campaign registration
  in `apps/api/src/runtime.ts` passes the new startup validation.
