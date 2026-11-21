# Task 07: Read-only content routes

Status: completed (2026-10-29)

## Goal

Online read access to entities, tags, and personal notes through sanctioned feature 04 helpers,
with totals and pages from the permitted set.

## Dependencies

- Task 05.

## Context

- TechSpec: `../_techspec.md` "API".
- Feature 04 task 04 report: `requireResource`/`requireCollection`, `request.contentAccess.page`,
  collection tripwire, callback-style hooks (Bun double-send quirk), safe denial bytes.
- BDD: "Reading, Listing, and Filtering", "Nobody else reads a personal note".

## Scope

### Change

- `apps/api/src/modules/content/routes.ts`: the GET routes in the techspec table (relationships
  route arrives with task 09), TypeBox schemas with `additionalProperties: false`,
  `config.contentRoute: true`.
- `apps/api/src/runtime.ts`: register after `contentAccess.install(app)`.
- Integration tests on the real runtime and on fixture apps.

### Do Not Change

- Any write route (writes are sync-only by design).

## Acceptance Criteria

- [x] Player list of 6 NPCs (4 visible) returns 4 items and total 4; bytes with hidden rows equal
  bytes with them deleted.
- [x] Hidden, missing, foreign-campaign, personal note of another author (GM roles included):
  byte-identical safe 404.
- [x] `visibility=gm_only` filter for a player returns empty with total 0.
- [x] Tag suggestions never include a tag present only on rows the actor cannot read.
- [x] Role claims in headers, query, or cookies change nothing.
- [x] Route inventory lists every new route as guarded; guard `no-unsanctioned-content-routes`
  passes.

## Verification

```bash
set -a; . ./.env; set +a
bun test apps/api/src/modules/content apps/api/src/modules/authorization --timeout 30000
bun run guard
bun run typecheck
```

## Evidence (2026-10-29)

- `apps/api/src/modules/content/routes.ts`: GET `/campaigns/:campaignId/entities` (type, tag,
  visibility, q, offset, limit), `/entities/:resourceId`, `/entity-tags?prefix`, `/personal-notes`,
  `/personal-notes/:resourceId`; `config.contentRoute: true`, `requireResource`/`requireCollection`,
  pages/totals via `request.contentAccess.page`, `additionalProperties: false`. Registered in
  `runtime.ts` after `contentAccess.install`.
- `routes.integration.test.ts`: 5 pass (player sees 4 of 6 NPCs, total 4, bytes equal after deleting
  hidden rows; 9 denial paths byte-identical to the missing-id 404 incl. GM roles on a player's note;
  `visibility=gm_only` empty for a player; tag suggestions exclude hidden-only tags; header/cookie role
  claims change nothing, query role claims are the same 400 for every caller; inventory lists every
  route guarded, no violations). `bun run guard` clean.
- Focused: `bun test apps/api/src/modules/content apps/api/src/modules/authorization`: 79 pass.

Gates (with `.env`, 2026-10-29): `bun run check` clean (434 files); `bun run typecheck` 13/13;
`bun run guard` 384 files, no violations; `bun run build` api + web exit 0; `bun run test:e2e` 64
passed; `bun test --timeout 30000` with `POWERSYNC_ENGINE_EXEC`: 1362 pass, 1 fail, 1363 tests, two runs;
the single failure differed per run (`identity-p0` operator recovery, then the MinIO read-URL
expiry) and each passes alone (13/13, 10/10): timing flakes outside feature 16.
