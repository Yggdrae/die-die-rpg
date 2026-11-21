# Task 06: Single-writer long-text holds

Status: completed. Verified with hold service, takeover, expiry, route, and client primitive tests.

## Scope

- Implement acquire/renew/takeover/release routes and authority repository.
- Enforce 120-second expiry and 30-second active renewal.
- Add client primitives for held state, takeover notice, and unsaved local text preservation.
- Test concurrent acquire/takeover/expiry with database time.

## Acceptance Criteria

- At most one active hold exists per field.
- Previous holder cannot write after takeover and is notified.
- Expiry releases authority without deleting saved or unsaved local content.

## Verification

```bash
bun test packages/sync apps/api/src/modules/sync apps/web/src/features/sync
bun run typecheck
```

## Record access (2026-10-26)

- Every `/sync/holds/:campaignId/{acquire,takeover,renew,release}` request first asks feature 04
  `ContentAccess.authorizeResource` for `update` on the named `(resourceClass, recordId)`.
  Unknown class, missing/hidden record, denied role, non-member and revoked holder all return the
  non-member 404 before any hold is read, so `heldBy` never names a holder of a record the
  caller cannot edit (author-private records included, GM roles too).
- Runtime: `campaign` records resolve through a ContentAccess facts source (record id = campaign
  id, deleted campaigns missing); every other class needs a registered adapter or source.
- Fixed `PostgresLongTextHoldRepository.databaseNow`: the `prepare: false` connection returns
  `timestamptz` as text, which made every runtime acquire fail with 500.
- Tests: `apps/api/src/modules/sync/holds-access.test.ts` (feature 04 fixture policies),
  `routes.test.ts` (decision input, identical 404 bodies on all four routes),
  `apps/api/src/modules/authorization/runtime.integration.test.ts` (PostgreSQL runtime).
