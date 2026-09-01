# Task 07: Visibility rules, revocation, and tombstone watermarks

Status: pending. Unit primitives exist; task 01 reviews, feature 04 declarations, and provider
integration evidence are missing.

## Scope

- Compile/register feature 04 sync predicates and equivalence tests.
- Implement replica drop on membership revocation/sign-out and reject queued writes.
- Implement subscriber watermarks and guarded tombstone purge.
- Test absence of hidden rows/counts/tombstones on player replicas.

## Acceptance Criteria

- A revoked replica loses campaign data/pending work on reconnect.
- No tombstone purges before every eligible subscriber condition holds and 90 days pass.
- API and sync visibility matrices agree exactly.

## Verification

```bash
bun test packages/sync packages/authorization
bun run guard
```
