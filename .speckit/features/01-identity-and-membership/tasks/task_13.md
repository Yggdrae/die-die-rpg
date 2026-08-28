# Task 13: Architecture Guard and P0 Acceptance Suite

## Goal

Prove the P0 feature against its BDD, security boundaries, cross-feature contracts, and repository
gates.

## Dependencies

- Tasks 07, 10, 11, and 12

## Scope

### Change

- Extend `tools/guard` to reject direct membership-store imports outside feature 01 and
  client-supplied campaign roles.
- Add Playwright coverage for signup to campaign creation, login/logout, logged-out invitation
  through authentication, invitation revocation, member removal, and recovery consumption.
- Add/complete PostgreSQL concurrency coverage for username, invitation, recovery, ownership, and
  removal transitions.
- Add security regression coverage for cookie/origin/rate-limit behavior and raw-secret absence
  from browser responses and captured logs.
- Map every P0 BDD scenario to an automated test or a named integration assertion.

### Do Not Change

- No generic final test rewrite, P1 behavior, unrelated refactor, or weakening/skipping of P0
  scenarios.

## Acceptance Criteria

- [ ] Every P0 BDD scenario is automated and traceable.
- [ ] PRD test 1 passes through initial synchronization.
- [ ] Architecture guard proves `ActorResolver` is the only supported role-read path.
- [ ] PostgreSQL races have exactly one valid winner and no partial writes.
- [ ] Full repository gates and identity E2E pass from a clean migrated database.

## Verification

```bash
bun run check
bun run typecheck
bun test
bun run guard
bun run build
```

Run the repository-adopted Playwright command documented when the suite is added, against the
documented local PostgreSQL stack.
