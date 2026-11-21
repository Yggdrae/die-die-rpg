# Task 01: Type configuration and pure content rules

Status: completed (2026-10-28)

## Goal

Create `packages/content` (`@rpg/content`) with the type/kind configuration and the pure rules
every later task reuses on server and device.

## Dependencies

- None.

## Context

- PRD: `../_prd.md` FR-001, FR-002, FR-003, FR-007; constraint "one implementation for all types".
- BDD: `../_bdd.md` "Type as Configuration", "Tags", "Custom Fields", "A name is required",
  "An unknown type is rejected", "Relationship kinds come from configuration".
- TechSpec: `../_techspec.md` "Proposed Architecture", "Interfaces and Contracts", "Decisions"
  D-01, D-02, D-08, D-11, D-18.
- Data: `../_db.md` column rules, "Visibility Invariant for Relationships".

## Scope

### Change

- `packages/content/{package.json,tsconfig.json,src/index.ts}` following `packages/campaigns`
  layout; dependencies `@rpg/contracts`, `@sinclair/typebox` only in this task.
- `src/types.ts`: type entries `npc`, `creature`, `location`, `item`, `faction`, `note`, `scene`,
  all enabled (D-02), with labels and quick-create second field `summary`; relationship kinds
  (D-08) `member_of` (member of / has member), `lives_at` (lives at / has resident), `located_at`
  (located at / location of), `knows` (knows / known by), `owns` (owns / owned by), `appears_in`
  (appears in / features), `related_to` (related to / related to), no source/target type
  restrictions; registry validation (unique IDs, token pattern `^[a-z][a-z0-9_]{0,63}$`).
- `src/domain.ts`:
  - name trim and required, limits (D-11): name 1..200, summary 0..280, description and note body
    0..50,000 characters;
  - tag normalization (D-18): trim, Unicode NFC, collapse internal whitespace to one space,
    lowercase, unique, sorted, frozen `Tag` 1..64, at most 32 per entity;
  - custom fields (D-01): object of at most 32 label → string pairs, label trimmed 1..64 and unique
    case-insensitively, value 0..1,000 characters, values only strings;
  - type-enabled check for create vs existing rows;
  - visibility intersection over `gm_only | everyone | players` (party -> fail closed) and the
    relationship bound predicate `isWithin(rel, source, target)`.
- `src/schemas.ts`: `EntityReplicaSchema`, `PersonalNoteReplicaSchema`,
  `RelationshipReplicaSchema` via `entitySchema()`, `QuickCreateInput`.
- `tools/guard/src/rules.ts`: rule forbidding entity-type ID literals outside
  `packages/content/src/types.ts` and tests (mirror of `no-system-id-branch`), with negative and
  positive fixtures in `rules.test.ts`.
- `adrs/ADR-001-generic-entity-model.md` in this feature folder (PRD ADR candidate, now approved).
- Unit tests for all of the above.

### Do Not Change

- `packages/contracts` (frozen). No database, policy, route, or UI code.

## Acceptance Criteria

- [x] A test adds a type entry in a test-local configuration and every pure rule accepts it with
  no code change.
- [x] Unknown or disabled type is rejected for create and accepted for an existing record.
- [x] `" Antagonist "`, `"antagonist"`, `"Village"` normalize to `["antagonist", "village"]`; a
  64-character tag is accepted, 65 rejected; a 33rd tag is rejected.
- [x] Limits: name of 200 accepted / 201 rejected; blank name rejected; summary 280 / 281;
  description 50,000 / 50,001.
- [x] Custom fields: "Price" and "price" on one entity rejected; 33 entries rejected; non-string
  value rejected; label of 65 characters rejected.
- [x] Unknown relationship kind rejected; every configured kind has a non-empty inverse label.
- [x] Intersection and bound are tested exhaustively over P0 modes and two-player target sets,
  including empty intersection -> `gm_only`.
- [x] No function branches on a specific type ID.

## Verification

```bash
bun test packages/content
bun run typecheck
bun x biome check packages/content
bun test tools/guard
bun run guard
```

## Evidence (2026-10-28)

- Package `packages/content` (`@rpg/content`): `src/types.ts` (7 enabled types, 7 kinds,
  `defineContentConfiguration` registry validation, `DEFAULT_QUICK_CREATE_TYPE`,
  `PERSONAL_NOTE_RECORD_TYPE`), `src/domain.ts` (D-11 limits in code points, D-18 tags, D-01 custom
  fields, type/kind checks, `prepareQuickCreate`, `intersectVisibility`/`visibilityWithin`/
  `isWithin`), `src/schemas.ts` (`EntityReplicaSchema`, `PersonalNoteReplicaSchema`,
  `RelationshipReplicaSchema`, `QuickCreateInput`, `CustomFields`).
- Guard rule `no-entity-type-branch` (`tools/guard/src/rules.ts`): branch shapes on an entity type
  (anywhere on `entityType`; inside the content scope also on `.type`/`typeId`) and MVP type
  literals inside the content scope; exempt: `packages/content/src/types.ts`, tests.
- ADR: `adrs/ADR-001-generic-entity-model.md`.
- `bun test packages/content/src/types.test.ts packages/content/src/domain.test.ts`: 23 pass (incl.
  test-local `vehicle` configuration, removed/disabled type, exhaustive audience-model check of
  intersection and bound over 5 P0 Visibilities, 125 bound cases, party fail-closed).
- `bun test tools/guard`: 108 pass (16 new: 9 failing fixtures, scope, elsewhere, passing cases,
  configuration/test exemption, real package scan).
- Gates (2026-10-28, with `.env`): `bun run check` clean (421 files); `bun run typecheck` 13/13
  workspaces exit 0; `bun run guard` 372 files, no violations; `bun run build` api and web exit 0;
  `bun test --timeout 30000` (with `POWERSYNC_ENGINE_EXEC`) 1316 pass, 0 fail (131 files); `bun run test:e2e` 64 passed.
