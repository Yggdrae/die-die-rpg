# Task 02: Entity and personal-note tables

Status: completed (2026-10-28)

## Goal

Persist entities and personal notes in PostgreSQL with the feature 04 Visibility representation,
version, tombstone, and the D-11 limits, and publish both tables to the sync provider.

## Dependencies

- Task 01.

## Context

- TechSpec: `../_techspec.md` "Data and Persistence", "Decisions" D-10, D-11.
- Data: `../_db.md` "`content_entities`", "`content_personal_notes`", "Constraints / Indexes",
  "Migration and Backfill".
- Feature 04 `_db.md` "Standard Relational Representation"; CHECK template in
  `packages/authorization/src/visibility.integration.test.ts`.
- Publication and replication-role contracts:
  `packages/identity/drizzle/0003_least_privilege_sync_publication.sql`,
  `0006_powersync_replication_role.sql`.

## Scope

### Change

- `packages/content/src/infra/postgres/schema.ts`: both tables, CHECKs (including the D-11
  lengths and `jsonb_array_length(tags) <= 32`), indexes, the shared
  `content_visibility_targets_valid(jsonb)` function (custom SQL in the generated migration).
- `drizzle.config.ts`: add the schema path.
- New migration via `bun run db:generate` (number assigned at generation; `0010` is the latest
  today and feature 07 may add more in parallel), plus in a forward migration
  `ALTER PUBLICATION powersync ADD TABLE "public"."content_entities", "public"."content_personal_notes"`
  and `GRANT SELECT` on both to `powersync_replicator`.
- `packages/content/src/infra/postgres/repository.ts`: load by id within campaign (tombstones
  excluded unless asked), list with type/tag/visibility/name-fragment filters, compare-and-set
  insert/update/tombstone that accept an executor (transaction) parameter.
- Update the publication and replication-role test expectations if they enumerate tables
  (`packages/sync/src/infra/postgres/{publication,replication-role}.integration.test.ts`).
- PostgreSQL integration tests.

### Do Not Change

- Existing migrations (never hand-edit an applied migration).
- `infra/powersync/sync-config.yaml` (task 04 adds streams; a published table with no stream is
  harmless, a stream without a policy is not).

## Acceptance Criteria

- [x] CHECKs reject: invalid mode, non-empty targets for `gm_only`/`everyone`, empty targets for
  `players`, unsorted/duplicate/uppercase targets, bad type token, blank name, name over 200,
  summary over 280, description/body over 50,000, non-array tags, more than 32 tags, non-object
  fields, version < 1, personal-note Visibility other than `players:[author]`.
- [x] Compare-and-set: stale version changes nothing and reports the actual version; two
  concurrent writes at the same version produce one winner.
- [x] Tombstone sets `deleted_at`, increments version, row stays loadable with `includeDeleted`.
- [x] Publication and replicator grants contain exactly the previous tables plus the two new ones.
- [x] Test tables/rows are cleaned up (0 left).

## Verification

```bash
set -a; . ./.env; set +a
bun run db:generate
bun run db:migrate
bun test packages/content packages/sync/src/infra/postgres --timeout 30000
bun run typecheck
```

## Notes

- Tests use try/catch, not `expect(promise).rejects` (hangs with bun + postgres.js).
- No FK to `campaigns`: cross-feature table.

## Evidence (2026-10-28)

- Migration `packages/identity/drizzle/0011_content_entities.sql` (generated, then the shared
  `content_visibility_targets_valid(jsonb)` function prepended and `ALTER PUBLICATION powersync ADD
  TABLE` + `GRANT SELECT ... TO powersync_replicator` appended before it was applied); applied with
  `bun run db:migrate`. Schema `packages/content/src/infra/postgres/schema.ts` added to
  `drizzle.config.ts`.
- Repository `packages/content/src/infra/postgres/repository.ts` (`@rpg/content/postgres`):
  `PostgresEntityRepository` (get/list/insert/update/tombstone/writeVisibility) and
  `PostgresPersonalNoteRepository` (get/listByAuthor/insert/update/tombstone); every write takes an
  executor (transaction); `CompareAndSetResult` = ok | not_found | deleted(current) |
  version_conflict(current).
- `bun test packages/content/src/infra/postgres`: 8 pass on PostgreSQL (22 entity CHECK cases + 5
  accepted boundaries, 10 personal-note CHECK cases, CAS stale/actual version, 5 concurrent rounds one
  winner each, tombstone, filters incl. LIKE metacharacters, notes); afterAll asserts 0 rows left.
- Publication/grants: `packages/sync/src/infra/postgres/publication.integration.test.ts` (ALLOWED
  + the two tables) and `replication-role.integration.test.ts` pass (grants == publication).
- Gates (2026-10-28, with `.env`): `bun run check` clean (421 files); `bun run typecheck` 13/13
  workspaces exit 0; `bun run guard` 372 files, no violations; `bun run build` api and web exit 0;
  `bun test --timeout 30000` (with `POWERSYNC_ENGINE_EXEC`) 1316 pass, 0 fail (131 files); `bun run test:e2e` 64 passed.
