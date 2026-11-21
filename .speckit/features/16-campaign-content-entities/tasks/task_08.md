# Task 08: Relationship persistence, policy, and visibility bound

Status: completed (2026-10-29)

## Goal

Store typed relationships with their own Visibility that can never be wider than either endpoint,
register `entity_relationship` with feature 04, and replicate it safely. Includes the B-1 adapter
refusal in feature 04.

## Dependencies

- Tasks 03, 04.

## Context

- TechSpec: `../_techspec.md` "Resource Policies", "Authorization and Visibility",
  "Cross-Feature Blocker Resolutions" B-1; D-07 (option A), D-08 (kinds, in task 01).
- Data: `../_db.md` "`content_entity_relationships`", "Visibility Invariant for Relationships".
- BDD: "Relationships" scenarios.
- Feature 04: `VisibilityWriteResult` (`packages/authorization/src/registry.ts`),
  `VisibilityService` (`visibility.ts`, rejection `incompatible_visibility`),
  `visibility-routes.ts` (400 `validation_failed`), `adapter-test-kit.ts`.

## Scope

### Change

- B-1 (additive, feature 04 owned): `VisibilityWriteResult` gains
  `{ ok: false, reason: 'invariant_violation' }`; `VisibilityService` maps it to
  `rejected('incompatible_visibility')` with no audit; `runVisibilityAdapterContract` gains an
  optional check (supplied invariant-violating fixture -> `invariant_violation`, row and version
  unchanged, `recordAudit` not called). Note the change in feature 04 `_techspec.md`
  "Current Facts".
- Schema + migration: `content_entity_relationships` (composite FKs to `content_entities`,
  self-link CHECK, partial unique, indexes), `ALTER PUBLICATION powersync ADD TABLE` and
  `GRANT SELECT ... TO powersync_replicator`.
- Repository; `entity_relationship` policy (same matrix as `campaign_entity`) and adapter. The
  adapter's `writeVisibility` locks both endpoints (`FOR SHARE`, ascending ID) and returns
  `invariant_violation` when the new Visibility exceeds their intersection.
- `SYNC_RULE_BINDINGS` + compiled YAML query in `authorized_content`; drift gate and simulated
  replicas extended.
- Invariant assertion query helper for tests.

### Do Not Change

- Entity adapter narrowing behavior (task 09).
- Existing adapters (they compile unchanged against the widened union).

## Acceptance Criteria

- [x] Adapter contract findings `[]` including the new B-1 check; policy conformance passes;
  existing feature 04/05 adapter suites still pass.
- [x] Reveal of a relationship beyond an endpoint returns 400 `validation_failed` /
  `incompatible_visibility`, unchanged row, no audit.
- [x] A relationship to a `gm_only` endpoint never reaches a player replica; truth table has no
  divergence.
- [x] CHECKs reject self-link and live duplicate; a tombstoned duplicate does not block a new link.
- [x] Publication and replicator grants include the new table and nothing else new.

## Verification

```bash
set -a; . ./.env; set +a
bun run db:generate
bun run db:migrate
bun test packages/content packages/authorization apps/api/src/modules/sync apps/api/src/modules/authorization packages/sync/src/infra/postgres --timeout 120000
bun run typecheck
```

## Evidence (2026-10-29)

- B-1 (`packages/authorization`, additive): `VisibilityWriteResult` `invariant_violation`;
  `VisibilityService` -> `incompatible_visibility`, no audit; kit optional check `invariant_refused`
  (11th). Unit tests +3 (`visibility.test.ts`). F04 `_techspec.md` Current Facts updated.
- Migration `packages/identity/drizzle/0012_content_relationships.sql` (generated, then publication +
  `GRANT SELECT ... TO powersync_replicator` appended before apply; applied). Composite FKs RESTRICT,
  self-link CHECK, kind token CHECK, Visibility CHECKs, partial unique (live), two indexes.
- `ENTITY_RELATIONSHIP_POLICY`, `PostgresRelationshipRepository`, `RelationshipVisibilityAdapter`
  (endpoints FOR SHARE ascending, then relationship FOR UPDATE; wider -> `invariant_violation`),
  `relationshipBoundRows` + `relationshipBoundViolations` (invariant assertion), replica table,
  `SYNC_RULE_BINDINGS`, compiled YAML query in `authorized_content`, holds branch for
  `entity_relationship` (derived), `rpg-powersync` restarted healthy (slot `powersync_17_638e` only).
- Tests: `relationships.integration.test.ts` contract 11 checks findings `[]`; CHECK/FK/duplicate/
  tombstoned-duplicate test; reveal within / refused. Runtime 400 `incompatible_visibility` unchanged and
  unaudited (`apps/api/.../relationships.integration.test.ts`). Drift gate 12 pass (truth table both
  dialects, simulated replicas incl. relationships, 2 relationship + 1 hold tamper). Publication
  allow-list and replication-role tests pass; audit-sync exclusion added. Live provider 7/7 (new
  relationship test; tampered YAML -> it fails, restored -> 7/7); engine check 7/7.
- Focused (task command): 334 pass, 0 fail.

Gates (with `.env`, 2026-10-29): `bun run check` clean (434 files); `bun run typecheck` 13/13;
`bun run guard` 384 files, no violations; `bun run build` api + web exit 0; `bun run test:e2e` 64
passed; `bun test --timeout 30000` with `POWERSYNC_ENGINE_EXEC`: 1362 pass, 1 fail, 1363 tests, two runs;
the single failure differed per run (`identity-p0` operator recovery, then the MinIO read-URL
expiry) and each passes alone (13/13, 10/10): timing flakes outside feature 16.
