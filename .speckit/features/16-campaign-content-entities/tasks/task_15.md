# Task 15: Export and search contributors

Status: completed (2026-10-30)

## Goal

Contribute entities and relationships to campaign export (feature 07) and documents to search
(feature 20) through the frozen registry contracts, never widening Visibility and never including
personal notes. Import is task 17.

## Dependencies

- Tasks 05, 08.

## Context

- Contracts: `ExportableModule`, `ExportChunk`, `SearchIndexer`, `SearchDoc`
  (`packages/contracts/src/registries.ts`).
- Feature 07: `ExportRegistry` registration in `apps/api/src/modules/portability/composition.ts`
  (`createExportRegistry`, placement `entities` -> `entities/content.json`, `countRecords`);
  online export double-reads and compares canonical checksums; conformance kit
  `exportContributorProblems` (`@rpg/campaign-portability/testing`).
- Feature 06: an acceptance test scans exporters for the word "audit"; keep it out of
  `contributors.ts`.
- TechSpec: D-10, D-12, D-13, B-5.
- BDD: "Export carries entities with their visibility", "Personal notes are not exported",
  "Search documents carry visibility".

## Scope

### Change

- `packages/content/src/contributors.ts`:
  - `ContentExporter` (`moduleId = 'content'`, chunk version `1`): `entities[]` (live rows plus
    tombstoned entities still referenced by a live relationship, flagged deleted) and
    `relationships[]` (live), each with its frozen `Visibility` as stored, ordered by ID so two
    reads are byte-identical. Frozen `import` returns `err('content_import_unsupported')` until
    task 17.
  - `ContentSearchIndexer`: one `SearchDoc` per live entity (`title` = name, `body` = summary +
    description Markdown source, `type`, `visibility`). No personal notes, no relationships.
- `apps/api/src/modules/portability/composition.ts`: register the exporter with placement
  `entities` and a record count; pass the content repository through `createOnlineExport`.
- Search: no feature 20 registry exists; export the indexer and contract-test it only.

### Do Not Change

- `packages/campaign-portability`, feature 05 exporter, feature 20 (absent).

## Acceptance Criteria

- [x] Export of fixture data: per-type live entity count and relationship count equal the live
  rows; only tombstones referenced by a live relationship appear, flagged deleted; every
  Visibility equals the stored one; `exportContributorProblems` returns no problem.
- [x] Two consecutive exports with no write between them have equal canonical checksums.
- [x] Personal notes absent from the chunk and from search documents.
- [x] `SearchDoc` validates against the frozen schema; Visibility equals the row's.
- [x] The online export e2e/integration tests of feature 07 still pass with the new contributor.

## Verification

```bash
set -a; . ./.env; set +a
bun test packages/content apps/api/src/modules/portability apps/api/src/campaign-export.integration.test.ts apps/api/src/modules/audit --timeout 30000
bun run typecheck
bun run guard
```

## Evidence (2026-10-30)

- `packages/content/src/contributors.ts` (exported from `@rpg/content`; no word "audit"):
  - `ContentExporter` (`moduleId 'content'`, chunk `1`): payload `{ campaignId, entities[],
    relationships[] }` (TypeBox `ContentChunk`). Entities: live rows plus tombstones referenced by a
    live relationship (`deleted: true`, `deletedAt`); relationships: live only; each with its stored
    Visibility; ordered by id (code-point order); no actor ids (`createdBy`/`updatedBy` are not
    exported). Frozen `import` -> `content_chunk_invalid` / `content_import_unsupported`.
  - Deviation (recorded here): custom fields are exported as sorted `{ label, value }` pairs, not as
    an object. A free-form label used as a JSON key could trip the feature 07 forbidden-key scanner
    (`email`, `password`, any `audit*` key) and fail the whole export; as values they cannot.
  - `ContentSearchIndexer` (`moduleId 'content'`): one `SearchDoc` per live entity, `title` = name,
    `body` = summary + blank line + description source, `type`, `campaignId`, stored Visibility,
    ordered by id; never reads notes or relationships.
  - `countContentRecords` (entities + relationships) for the job summary.
- `apps/api/src/modules/portability/composition.ts`: `createExportRegistry`/`createOnlineExport` take
  `content: ContentExporter`, registered with placement `entities` (`entities/content.json`) and
  `countContentRecords`. Deviation: the composition root (`runtime.ts`) builds the exporter over
  `PostgresEntityRepository` + `PostgresRelationshipRepository` and passes it in, because guard rule
  `no-content-persistence-imports` keeps `@rpg/content/postgres` out of `modules/portability`.
- Search: feature 20 has a PRD only (`.speckit/features/20-global-search/_prd.md`), no registry or
  host code. The indexer is exported and contract-tested only; nothing calls it at runtime (gap).
- Tests:
  - `apps/api/src/modules/portability/content-contributor.integration.test.ts` 2 (PostgreSQL, sandbox
    fixture: 5 locations, 6 NPCs, 5 items; links; tombstones; a personal note): per-type live counts
    equal the SQL live counts (`{location: 5, npc: 6, item: 3}`), 3 live links, only the referenced
    tombstone (Supply Crate) present and flagged, every Visibility equals the stored one, kit `[]`,
    canonical checksums of two exports equal, note body/title and GM id absent; search: 14 docs,
    each `check(SearchDoc)`, equal to the row, Weathered Letter `players:[A]`, no tombstone, no note.
  - `packages/content/src/contributors.test.ts` 3 (input order never changes the bytes; tombstone
    selection; chunk schema; frozen import codes; search bodies).
  - `apps/api/src/modules/portability/composition.test.ts`: registry lists `content -> entities`;
    the export kit passes for content (3 records; labels `Email`/`Auditor` pass the scan as values).
  - `apps/api/src/campaign-export.integration.test.ts` (feature 07, runtime + HTTP): job summary
    now includes `content` (3 records); `entities/content.json` carries the revealed NPC
    `players:[player]`, the GM-written location `gm_only`, and the link; personal note body/title
    absent; the GM's id still absent (no actor ids); typical export with the sandbox scale: 16
    content records, 262 ms, 88,001 bytes.
- Focused (with `.env`): `bun test packages/content apps/api/src/modules/portability
  apps/api/src/campaign-export.integration.test.ts apps/api/src/modules/audit --timeout 30000`
  137 pass, 0 fail; `bun run typecheck` exit 0; `bun run guard` no
  violations.
