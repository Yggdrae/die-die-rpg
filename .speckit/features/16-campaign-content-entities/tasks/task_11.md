# Task 11: Web entity list, filters, and detail

Status: completed (2026-10-30)

## Goal

One generic list and detail screen for every type, reading the local replica, with type/tag/
visibility filters and name-fragment search that work offline.

## Dependencies

- Tasks 04, 07.

## Context

- TechSpec: `../_techspec.md` "Web".
- BDD: "Every MVP type uses the same screens", "A GM finds an entity by a name fragment",
  "Filtering narrows the permitted set".
- Feature 03 task 08: browser delivery through the PowerSync web SDK is verified; the replica
  `Schema` from task 04 is the data source. Component and model tests use the `SyncedRepository`
  double (`@rpg/contracts/testing`) with `FIXTURE_ENTITIES`.

## Scope

### Change

- `apps/web/src/features/content/`: `EntityList`, `EntityDetail` (summary, tags, custom fields,
  description shown as escaped plain text with line breaks per D-10), filter model, search over
  the local repository; labels from type configuration only; sync status/pending indicator from
  `apps/web/src/features/sync/SyncStatus.tsx`.
- Unit tests (static markup, as feature 04 task 06 did) and model tests.

### Do Not Change

- Feature 04/03 web components (consume only).

## Acceptance Criteria

- [x] A test-local extra type renders in list, filter, and detail with no component change.
- [x] Filters combine (type + tag) and match the BDD outline over fixture data.
- [x] Name-fragment search is case-insensitive and needs no network.
- [x] A description containing `<script>` or Markdown renders as literal text (no HTML parsing).
- [x] No component branches on a type ID (guard rule added in task 01 passes).

## Verification

```bash
bun test apps/web/src/features/content
bun run typecheck
bun run build
```

## Evidence (2026-10-30)

- `apps/web/src/features/content/`: `EntityViews.tsx` (`EntityFiltersView`, `EntityListView`,
  `EntityDetailView`, `PlainText` = escaped text with `white-space: pre-wrap` per D-10),
  `content-model.ts` (labels/options from configuration, tag suggestions, affordance hints from the
  policies, relationship views, error copy), `useContentData.ts` (re-reads the local replica on every
  replica/queue/conflict/hold change), `content-source.ts` (`ContentSource` + `browserContentSource` over
  the browser replica), `ContentWorkspace.tsx` (list + filters + detail). Mounted in `CampaignDashboard`
  beside the existing `SyncStatusIndicator`.
- Browser replica data path (feature 03, additive): `BrowserSyncedRepository` +
  `BrowserSyncSession.repository()` in `packages/sync/src/browser.ts`; row codecs
  `ENTITY_/PERSONAL_NOTE_/RELATIONSHIP_ROW_CODEC` in `packages/content/src/replica-codec.ts`;
  `matchesEntityFilter` (+ `visibilityMode`) in `offline.ts`.
- Tests: `content-model.test.ts` 12 (BDD outline over `FIXTURE_ENTITIES`: type npc, tag antagonist,
  visibility gm_only, location + site; player options never offer gm_only; name fragment through
  `EntityLocalRepository` over the `SyncedRepository` double), `content-views.test.tsx` 8 (test-local
  `vehicle` type in list, filter, detail; `<script>`/Markdown literal; quick create; notes; links),
  `replica-codec.test.ts` 5, `browser-repository.test.ts` 7.
- Live (`apps/web/e2e/content.e2e.ts`, real API + PowerSync + MinIO): lists and details come from
  browser SQLite in every test; player lists exclude hidden rows.
- Focused: `bun test apps/web/src/features/content` 27 pass, 0 fail.

Gates (with `.env`, 2026-10-30): `bun run check` clean (462 files); `bun run typecheck` 13/13
exit 0; `bun run guard` 412 files, no violations; `bun run build` api + web exit 0;
`bun test --timeout 30000` 1406 pass, 8 skip, 1 fail (MinIO read-URL expiry, a known timing flake;
`packages/attachments/src/infra/s3` alone 10/10); the 8 engine-gated sync tests pass with
`POWERSYNC_ENGINE_EXEC` (`apps/api/src/modules/sync` 79/79); `bun run test:e2e` 72 passed, 1 failed
(live-sync "queued writes of a revoked member", the known flake; `live-sync.e2e.ts` alone 9/9).
