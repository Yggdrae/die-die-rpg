# Task 10: Published entity directory API

Status: completed (2026-10-30)

## Goal

Give features 17, 18, and 19 one sanctioned way to resolve and list entities for an actor,
server-side and on the device, without importing feature 16 internals.

## Dependencies

- Tasks 05, 08.

## Context

- PRD: FR-016; feature 18 FR-008/FR-009, feature 19 FR-002/FR-013, feature 17 FR-001.
- TechSpec: `../_techspec.md` "Interfaces and Contracts" (`EntityDirectory`,
  `EntityLocalRepository`).
- BDD: "Another feature resolves entities through the published API".
- D-02: feature 18 resolves its current scene (type `scene`) and the scene's linked location and
  NPCs through this API; nothing here is scene-specific.

## Scope

### Change

- `packages/content/src/directory.ts`: `EntityDirectory.resolve(actor, campaignId, ids)` and
  `list(actor, campaignId, filter, page)`; decisions per record through
  `AuthorizationService.decide`; unreadable and missing both absent.
- Device: `EntityLocalRepository.resolve/list/quickCreate` exported from `@rpg/content`.
- Export only these from the package entry point; guard check that other features import
  `@rpg/content` root only (`no-deep-package-imports` already applies).
- Unit tests over fixtures; one PostgreSQL test.

### Do Not Change

- Any feature 17/18/19 code (does not exist yet).

## Acceptance Criteria

- [x] For player A, a `gm_only` id and a non-existent id produce identical results.
- [x] Personal notes are never returned by the directory.
- [x] No API accepts caller-supplied Visibility or role facts.

## Verification

```bash
set -a; . ./.env; set +a
bun test packages/content --timeout 30000
bun run guard
bun run typecheck
```

## Evidence (2026-10-30)

- `packages/content/src/directory.ts` (root entry point): `EntityDirectory({ entities, decider, actors })`
  with `resolve(caller, campaignId, ids, { includeDeleted? })` -> `Map<id, EntitySummary>` and
  `list(caller, campaignId, { type, tag, nameFragment }, { offset, limit })` -> `{ items, total }`;
  `entityFactsOf` / `entitySummaryOf` (the API routes now import `entityFactsOf` from here). The caller
  supplies only `userId` (an `ActorRef` may be passed; its role is ignored): the role is resolved
  through identity's `ActorResolver` shape and every record is decided with
  `AuthorizationService.decide(read)` on stored facts. No Visibility input exists. Missing, foreign,
  malformed, unreadable, and non-member answers are all absent/empty. Summaries carry no description,
  custom fields, or tags. Personal notes are another class/table: never read or decided.
- Device API: `EntityLocalRepository.resolve/list/quickCreate` (already in `offline.ts`) exported from
  `@rpg/content`; `list` now shares `matchesEntityFilter` and sorts by name.
- Guard rule `no-content-persistence-imports`: `@rpg/content/postgres` only in `packages/content/`,
  `apps/api/src/modules/content/`, `apps/api/src/runtime.ts`, and tests (`rules.test.ts` +2).
- Tests: `directory.test.ts` 8 (fixtures; gm_only vs missing identical for player A, forged role,
  personal notes never decided, scene like any type, tombstones only on request, list counts the
  permitted set) + `directory.integration.test.ts` 1 (PostgreSQL, incl. a note row in the campaign).
- Focused: `bun test packages/content --timeout 30000` 78 pass, 0 fail; `bun test tools/guard` 110 pass.
- Not wired into the runtime yet: no consumer exists (features 17/18/19 compose it).

Gates (with `.env`, 2026-10-30): `bun run check` clean (462 files); `bun run typecheck` 13/13
exit 0; `bun run guard` 412 files, no violations; `bun run build` api + web exit 0;
`bun test --timeout 30000` 1406 pass, 8 skip, 1 fail (MinIO read-URL expiry, a known timing flake;
`packages/attachments/src/infra/s3` alone 10/10); the 8 engine-gated sync tests pass with
`POWERSYNC_ENGINE_EXEC` (`apps/api/src/modules/sync` 79/79); `bun run test:e2e` 72 passed, 1 failed
(live-sync "queued writes of a revoked member", the known flake; `live-sync.e2e.ts` alone 9/9).
