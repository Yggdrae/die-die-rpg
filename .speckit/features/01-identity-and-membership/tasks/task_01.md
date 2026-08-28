# Task 01: Freeze Security, Lifecycle, and Persistence Decisions

## Goal

Remove every feature-owned blocker that would otherwise force implementation to invent security,
lifecycle, or persistence behavior.

## Dependencies

- None

## Scope

### Change

- Decide username normalization, allowed characters, and length limits.
- Decide password limits and select the maintained password-hashing package, algorithm, and
  parameters.
- Decide token entropy/digest rules and session, invitation, and recovery lifetimes.
- Decide credential-row retention and password-recovery session revocation.
- Decide GM self-removal, invitation revocation scope, public invitation preview fields, and the
  former owner's outcome during ownership transfer.
- Decide the account-deletion/retention policy or explicitly keep deletion unavailable for P0.
- Select migration/query tooling and the trusted-host recovery command shape.
- Write the required opaque-server-session ADR and update `_prd.md`, `_bdd.md`, `_techspec.md`, and
  `_db.md` so no resolved item remains contradictory or marked TODO.

### Do Not Change

- No production code, migration, dependency installation, P1 email flow, or feature 03 purge
  policy.
- Do not select feature 02's owner-invariant mechanism without its persistence design.

## Acceptance Criteria

- [x] Every feature-01-owned item in `_db.md` "Blocking TODOs Before Implementation Tasks" has an
  approved answer in the governing artifact.
- [x] Security values are concrete and testable, including expiry boundaries and secret sizes.
- [x] Ownership transfer and GM self-removal have unambiguous BDD scenarios.
- [x] The ADR records opaque sessions, the stateless alternative, consequences, and revocation
  rationale.
- [x] Remaining external blockers name feature 02 or 03 and the exact decision required.

## Verification

```bash
rg "TO[D]O:" .speckit/features/01-identity-and-membership
```

Review every remaining match as explicitly deferred or externally owned. Check artifact
traceability and contradictions manually.
