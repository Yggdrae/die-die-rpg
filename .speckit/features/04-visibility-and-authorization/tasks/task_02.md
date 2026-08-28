# Task 02: Resource policy registry and author-private rule

Status: pending. Depends on task 01.

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

