# Task 09: Relationship mutations and endpoint narrowing

Status: completed (2026-10-29)

## Goal

Create and delete relationships offline through sync, narrow relationships when an endpoint is
narrowed (D-07 option A), and show broken links after an endpoint delete.

## Dependencies

- Tasks 06, 08.

## Context

- TechSpec: `../_techspec.md` "Mutation Appliers" step 5, "Authorization and Visibility"; D-07
  (option A), D-15 (personal notes are never endpoints).
- Data: `../_db.md` "Visibility Invariant for Relationships" (maintenance steps and lock order).
- BDD: "Hiding an endpoint hides its relationships", "Relationships survive as broken links",
  "Duplicate and self links are refused", "A personal note takes no attachments or links".

## Scope

### Change

- `RelationshipService` + `RelationshipSyncMutationApplier`
  (`tableName = 'content_entity_relationships'`): insert and tombstone only; no update (a kind
  change is tombstone + insert). Endpoints locked `FOR SHARE` in ascending ID order.
- Entity adapter `writeVisibility`: in the same transaction, narrow every live relationship
  touching the entity whose Visibility is no longer within the endpoints' intersection to that
  intersection (version +1 each, one `visibility.unrevealed` event per relationship via
  `recordWithin` on the same executor, actor = the entity's changer). Lock order: entity, then
  relationships `FOR UPDATE`.
- Relationship audit declarations `entity.relationship_created`, `entity.relationship_deleted`
  added to `CONTENT_AUDIT_DECLARATIONS` and the row `16` action list.
- GET `/campaigns/:campaignId/entities/:resourceId/relationships` (both directions, per-row
  decision, other endpoint as summary or `{ deleted: true }`).
- Device-side pre-validation with the task 01 bound against locally visible endpoints.

### Do Not Change

- Feature 04 `VisibilityService`.

## Acceptance Criteria

- [x] Hiding an endpoint leaves no live relationship wider than the invariant (assertion query);
  players lose the relationship on next sync (simulated replica).
- [x] Concurrent link create and endpoint narrowing never commit a violating row (two-connection
  test).
- [x] Endpoint delete changes no relationship; the route shows the link with `deleted: true` to
  actors who could read it.
- [x] Self-link, duplicate, unknown kind, foreign-campaign endpoint, tombstoned endpoint on create,
  personal-note ID as endpoint, and an update operation are rejected.
- [x] Every narrowing and every accepted create/delete has exactly one audit event; feature 06
  `contributors.test.ts` passes.

## Verification

```bash
set -a; . ./.env; set +a
bun test packages/content apps/api/src/modules/content apps/api/src/modules/audit --timeout 30000
bun run typecheck
bun run guard
```

## Evidence (2026-10-29)

- `RelationshipService` + `RelationshipSyncMutationApplier` (insert/tombstone; update ->
  `invalid_payload`), endpoint locks FOR SHARE ascending; `EntityVisibilityAdapter` narrows touching
  live relationships in its transaction (one `visibility.unrevealed` each, origin
  `narrowingOriginId(relationship, version)`, actor from the additive `VisibilityWrite.actor`; no actor
  -> whole change refused). Relationship audit actions registered (row 16).
- GET `/campaigns/:campaignId/entities/:resourceId/relationships` (both directions, per-row
  `authorizeResource` for the link and the other endpoint, deleted endpoint -> `{ deleted: true }`).
- Device: `RelationshipLocalRepository` (kind, self, endpoints visible, bound, duplicate).
- Tests: narrowing test (targeted + gm_only, audits, untouched within/tombstoned); concurrent create vs
  narrowing on two connections, 12 rounds, no violating row (mutation: dropping the endpoint
  FOR SHARE -> fails); 9 create refusals incl. note id, tombstoned and foreign endpoint; endpoint delete
  leaves the link; runtime: link writes and audit rows, narrowing via PATCH audited and gone from the
  player's compiled stream, route with broken link; `offline.test.ts` link pre-validation;
  `contributors.test.ts` 4/4.
- Focused (task command): 125 pass, 0 fail.

Gates (with `.env`, 2026-10-29): `bun run check` clean (434 files); `bun run typecheck` 13/13;
`bun run guard` 384 files, no violations; `bun run build` api + web exit 0; `bun run test:e2e` 64
passed; `bun test --timeout 30000` with `POWERSYNC_ENGINE_EXEC`: 1362 pass, 1 fail, 1363 tests, two runs;
the single failure differed per run (`identity-p0` operator recovery, then the MinIO read-URL
expiry) and each passes alone (13/13, 10/10): timing flakes outside feature 16.
