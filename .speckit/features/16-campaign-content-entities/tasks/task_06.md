# Task 06: Sync mutation appliers for entities and notes

Status: completed (2026-10-29)

## Goal

Make `POST /sync/mutations` the write path for entities and personal notes, with re-authorization,
versions, long-text holds, and in-transaction audit. Includes the B-2 session pass-through.

## Dependencies

- Tasks 04, 05.

## Context

- TechSpec: `../_techspec.md` "Mutation Appliers", "Cross-Feature Blocker Resolutions" B-2.
- Pattern: `apps/api/src/modules/sync/campaign-applier.ts`,
  `campaign-applier.integration.test.ts`; feature 06 task 02 report (applier must call
  `recordAudit` inside its transaction or it silently falls back to after-commit).
- Holds: `LongTextHoldService.mayWrite` in `packages/sync/src/holds.ts` (no caller yet); the sync
  routes already hold `user.sessionId` (`apps/api/src/modules/sync/routes.ts`).

## Scope

### Change

- B-2 (additive, feature 03 owned): `AuthorityMutationContext` in `packages/sync/src/model.ts`
  gains `readonly sessionId?: string`; `AuthorityMutationService.apply` (`packages/sync/src/authority.ts`)
  takes an optional `{ sessionId }` and passes it to `applier.apply`; the mutation route passes the
  authenticated `user.sessionId`. Never read from the payload. Note the change in feature 03
  `_techspec.md` "Current Facts".
- `apps/api/src/modules/content/appliers.ts`: `EntitySyncMutationApplier`
  (`tableName = 'content_entities'`), `PersonalNoteSyncMutationApplier`
  (`'content_personal_notes'`), operations insert/update/tombstone; outcome mapping
  (`accepted` with version and cursor, `conflict` with `currentValue`, `error` codes
  `invalid_payload`, `not_found_or_forbidden`, `hold_required`).
- Long-text fields (`description`, `body`) require `mayWrite({ field, holderSessionId:
  context.sessionId, expectedVersion })` true; a missing `sessionId` is `hold_required`.
- `fields` validated with the task 01 D-01 rule; limits and tags with the D-11/D-18 rules.
- `apps/api/src/runtime.ts`: register both appliers.
- Device side: `packages/content/src/offline.ts` local repositories over `SyncedRepository`
  writing queue entries with the audit payload (feature 03 `LocalMutationInput`).
- Tests: unit (outcomes), PostgreSQL integration through `AuthorityMutationService`.

### Do Not Change

- `AuthorityMutationService` / receipt store (feature 03) beyond B-2.

## Acceptance Criteria

- [x] Accept, stale-version conflict (both values present), deny (role downgraded while offline),
  invalid type, over-limit field, tombstone, replay (no second event) each tested on PostgreSQL.
- [x] Description write without a hold, with an expired hold, after takeover, from a different
  session of the same user, and with no session in the context is rejected `hold_required` and
  leaves the row unchanged; with a current hold for the uploading session it is accepted.
- [x] Existing appliers and their tests pass unchanged with the B-2 field present.
- [x] Each accepted mutation has exactly one in-transaction audit event (`audit: held`); disabling
  the `recordAudit` call fails the tests.
- [x] A player's personal-note mutation for another author's note returns
  `not_found_or_forbidden` identical to a missing id.
- [x] Offline local create/update/delete through the device repository round-trips to accepted.

## Verification

```bash
set -a; . ./.env; set +a
bun test apps/api/src/modules/content apps/api/src/modules/sync packages/content packages/sync --timeout 30000
bun run typecheck
bun run guard
```

## Evidence (2026-10-29)

- B-2 (`packages/sync`, additive): `AuthorityMutationContext.sessionId?`,
  `AuthorityMutationService.apply(userId, batch, { sessionId? })`, `POST /sync/mutations` passes
  `user.sessionId`. Also additive: `MutationAuditHook(transaction, authored?)` with
  `AuthoredMutationAudit`; the authority records the server-authored event (in transaction and in the
  after-commit fallback) instead of the client envelope's content; participant inputs carry
  `targetVisibility` (`apps/api/src/modules/audit/composition.ts` passes it to the recorder). F03
  `_techspec.md` Current Facts updated.
- `apps/api/src/modules/content/appliers.ts`: `EntitySyncMutationApplier`,
  `PersonalNoteSyncMutationApplier` (payload = device record; `holdVersion` for long text; envelope
  required; codes `invalid_payload`, `not_found_or_forbidden`, `record_deleted`, `hold_required`,
  retryable `authority_unavailable`). Registered in `runtime.ts` with one shared `LongTextHoldService`.
- `packages/content/src/offline.ts`: `EntityLocalRepository`, `PersonalNoteLocalRepository` over
  `SyncedRepository`.
- Tests: `appliers.integration.test.ts` 8 pass (accept + replay one event; conflict with both values;
  deny after downgrade; 8 invalid payloads; tombstone + edit-of-tombstone; hold: no session, no hold
  version, other session same user, other user, expired, taken over all `hold_required` with row
  unchanged, current holder accepted; another author's note == missing id; rollback; offline SQLite
  queue round trip for entities and a note). Mutation check: applier not calling `recordAudit` -> 4 of
  8 fail. `authority.test.ts` +3 (session pass-through, authored replaces envelope, authored fallback);
  `routes.test.ts` asserts the session reaches appliers; existing appliers' tests unchanged and pass.
  `offline.test.ts` 4 pass.
- Focused: `bun test apps/api/src/modules/content apps/api/src/modules/sync packages/content packages/sync`:
  294 pass, 0 fail.

Gates (with `.env`, 2026-10-29): `bun run check` clean (434 files); `bun run typecheck` 13/13;
`bun run guard` 384 files, no violations; `bun run build` api + web exit 0; `bun run test:e2e` 64
passed; `bun test --timeout 30000` with `POWERSYNC_ENGINE_EXEC`: 1362 pass, 1 fail, 1363 tests, two runs;
the single failure differed per run (`identity-p0` operator recovery, then the MinIO read-URL
expiry) and each passes alone (13/13, 10/10): timing flakes outside feature 16.
