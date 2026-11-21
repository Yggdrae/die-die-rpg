# Task 17: Content import contributor

Status: completed (2026-10-30). B-5 resolved: the note was ratified 2026-10-28 and feature 07 task 06 landed (`ImportCoordinator`).

## Goal

Restore the content chunk into an imported campaign through the ratified transaction-aware import
surface, remapping identifiers and never widening Visibility.

## Dependencies

- Task 15.
- B-5: ratification of
  `../../00-platform-foundation/2026-10-27-transaction-aware-import-contract-change.md` (shapes
  added to `packages/contracts/src/registries.ts`) and feature 07 task 06 (import coordinator).
  Do not start before both land. If the note is rejected, this task is cancelled and import stays
  disabled (`content_import_unsupported`, preserved by feature 07).

## Context

- TechSpec: `../_techspec.md` "Cross-Feature Blocker Resolutions" B-5.
- Data: `../_db.md` "Lifecycle, Retention, and Export".
- BDD: "Export carries entities with their visibility" (import half).

## Scope

### Change

- `packages/content/src/contributors.ts`: `ContentExporter` also implements `ImportableModule`
  (`importChunkVersions: ['1']`).
  - `validate`: TypeBox validation of the chunk, D-11/D-18/D-01 rules, configured kinds; returns
    `defines` with kinds `campaign_entity` and `entity_relationship` (Resource Class names, which
    feature 05 uses for attachment owners); no write.
  - `restore`: writes only through `context.transaction` via a package function such as
    `restoreContentWithin(executor)`; new IDs from `mapId`; relationship endpoints remapped;
    `players` targets remapped with `mapId('member', id)`, unmapped -> `gm_only` with
    `visibility_narrowed_to_gm_only`; preserves deleted-endpoint relationships; records no audit
    beyond what the coordinator specifies.
- Registration of the importable surface where feature 07 task 06 composes importers.

### Do Not Change

- `packages/contracts` (changed only by the ratification step), feature 07 coordinator.

## Acceptance Criteria

- [x] Round trip on fixture data: equal counts per type and relationship count; every Visibility
  equal or narrower; no `everyone` produced from a `players` target.
- [x] A failing `restore` (forced) leaves no content row after the coordinator rolls back.
- [x] `validate` of an invalid chunk writes nothing and returns a safe code.
- [x] Imported attachments owned by `campaign_entity` resolve to the new entity IDs.

## Verification

```bash
set -a; . ./.env; set +a
bun test packages/content apps/api/src/modules/portability --timeout 30000
bun run typecheck
```

## Evidence (2026-10-30)

- `packages/content/src/contributors.ts`: `ContentExporter implements ExportableModule,
  ImportableModule` (`importChunkVersions: ['1']`), constructed with optional
  `ContentImportDependencies { writer, unwrap, config? }`.
  - `validate`: TypeBox `ContentChunk`, then the write rules per entity (existing-type token rule so a
    removed type keeps its records, D-11 name/summary/description, D-18 tags, D-01 fields incl. exact
    duplicate labels, `Metadata`, `deleted` consistent with `deletedAt`) and per relationship
    (configured kind, endpoints present in the chunk, no self link, no duplicate live link, unique
    ids). Returns `defines` with kinds `campaign_entity` / `entity_relationship`; never writes.
    Codes: `content_chunk_invalid`, `content_entity_invalid`, `content_relationship_invalid`.
  - `restore`: ids from `mapId`; Visibility through feature 04 `visibilityForImport` (unmapped
    `players` target -> `gm_only` + `visibility_narrowed_to_gm_only`); each relationship clamped to
    the intersection of its own and both imported endpoints' Visibility (D-07; a clamp emits the same
    warning); tombstoned endpoints kept (broken links); writes only through
    `writer.restoreWithin(unwrap(context.transaction), plan)`; no audit. Codes:
    `content_id_unmapped`, `content_import_unavailable` (no writer), writer codes.
- `packages/content/src/infra/postgres/import-writer.ts` (`@rpg/content/postgres`):
  `restoreContentWithin(executor, repositories, plan)` (entities, then tombstones, then links via the
  feature 16 repositories; `content_restore_conflict` on an existing id or duplicate link) and
  `PostgresContentImportWriter`.
- Registration: `apps/api/src/runtime.ts` builds `new ContentExporter({ entities, relationships },
  { writer: new PostgresContentImportWriter(...), unwrap: importTransactionHandle })`; the exporter
  itself is the registry's importable surface (feature 07 `importableOf`). No change to
  `packages/contracts` or the feature 07 coordinator.
- Attachments: feature 05 restores no attachment row in P0 (no binaries,
  `attachment_binary_not_restored`). The round trip asserts that a manifest entry owned by
  `campaign_entity` X maps (`deriveImportId(job, 'campaign_entity', X)`, the id `mapId` gives every
  contributor) to the restored entity row with X's name, so a future attachment restore resolves.
- Tests:
  - `packages/content/src/contributors.test.ts` +3: validate defines and 11 invalid variants with
    safe codes and no writer call; restore remaps, narrows (`players:[A,B]` with B unmapped ->
    `gm_only`), clamps a mapped link to its narrowed endpoint, keeps the tombstone, never produces
    `everyone` from `players`; writer failure / unmapped id / no writer -> safe codes.
  - `apps/api/src/campaign-import.integration.test.ts` (runtime + HTTP + PostgreSQL): round trip with
    4 entities (one tombstone) and 3 links: report `content` restored 7 with two narrowing warnings
    (the letter and its link targeted a player whose membership is not imported); re-export per-type
    counts and link count equal; every Visibility equal or narrower, none widened to `everyone`;
    fields preserved; broken link kept; D-07 bound holds (`relationshipBoundRows`, no violation);
    rows created by the importer; the entity-owned attachment's owner resolves. Rollback test: the
    real content contributor (PostgreSQL writer) restores inside the transaction (3 live links
    visible in it), then `zz-broken` fails (`err` and `throw`): 0 content rows after rollback;
    without it the import commits and 4 entities exist. Unknown-chunk test updated for the extra
    module.
  - Mutation checks: storing the source Visibility instead of `visibilityForImport` -> unit 1 fail
    and runtime round trip fail; removing the D-07 clamp -> unit 1 fail.
- Focused (with `.env`): `bun test packages/content apps/api/src/modules/portability --timeout
  30000` 89 pass, 0 fail; `apps/api/src/campaign-import.integration.test.ts` 6/6; `bun run typecheck` exit 0.
