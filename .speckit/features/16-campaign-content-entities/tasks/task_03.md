# Task 03: Resource policies, adapter, facts source, conformance

Status: completed (2026-10-28)

## Goal

Register `campaign_entity` and `personal_note` with feature 04 so the runtime starts with them,
reveal works through the generic visibility route, and the shared kits prove the declarations.

## Dependencies

- Task 02.

## Context

- TechSpec: `../_techspec.md` "Resource Policies" (approved matrix: D-04 players read only, D-05
  `owner`/`gm`/`assistant_gm` identical, D-06 personal notes for players only), "Authorization and
  Visibility".
- Feature 04 API: `packages/authorization/src/registry.ts` (`ResourcePolicy`, `OwnershipRule`,
  `VisibilityAdapter`), `adapter-test-kit.ts`, `test-kit.ts`.
- Hand-over: the first content owner must register adapter + policy with
  `requireVisibilityAdapters: true` and run `runVisibilityAdapterContract`.

## Scope

### Change

- `packages/content/src/policies.ts`:
  - `CAMPAIGN_ENTITY_POLICY`: `owner`, `gm`, `assistant_gm` read/create/update/delete/reveal;
    `player` read; `observer` none; default `gm_only`; reveal targets `players`.
  - `PERSONAL_NOTE_POLICY`: `player` read/create/update/delete; `owner`, `gm`, `assistant_gm`,
    `observer` none; `defaultVisibility: 'explicit'`; Ownership Rule on read, create, update,
    delete with no exempt role; `ownershipColumns.authorUserId = author_user_id`.
- `packages/content/src/visibility-adapters.ts`: `campaign_entity` adapter over the task 02
  repository: `loadFacts` (undefined for missing, foreign, tombstone), `writeVisibility`
  (compare-and-set, `recordAudit(tx)` once after match). Relationship narrowing is added in
  task 09.
- `apps/api/src/modules/sync/sync-rules.ts`: add both policies to `REGISTERED_RESOURCE_POLICIES`
  (bindings come in task 04; `campaign_entity` is registered with its adapter in `runtime.ts`).
- `apps/api/src/runtime.ts`: register the adapter; add a `personal_note` `ResourceFactsSource` to
  `factsSources` (author included in facts).
- Tests: adapter contract, policy conformance, `checkAuthorPrivate('personal_note')`, GM-only
  default per enabled type, runtime starts with the new classes.

### Do Not Change

- `packages/authorization` (B-1 lands in task 08).
- Sync YAML (task 04).

## Acceptance Criteria

- [x] `runVisibilityAdapterContract` findings `[]` for `campaign_entity`, with `tombstone`
  supplied (all 10 checks run).
- [x] `runPolicyConformance` passes for both classes; `checkAuthorPrivate` findings `[]`.
- [x] Decision table test: player create/update/delete/reveal of `campaign_entity` denied; every
  GM role allowed; GM roles denied every capability on `personal_note`; a player denied another
  player's note.
- [x] Registration fails if a role row is missing (proves no default-allow).
- [x] The generic `PATCH .../resources/campaign_entity/:id/visibility` reveals, un-reveals, conflicts,
  and audits on PostgreSQL; `personal_note` on the same route returns the safe 404.
- [x] Audit target declarations (`auditTargetDeclarationsFor`) keep `gm_only` snapshots for both
  classes (reveal-capable / author-scoped).

## Verification

```bash
set -a; . ./.env; set +a
bun test packages/content apps/api/src/modules/authorization apps/api/src/modules/audit --timeout 30000
bun run typecheck
bun run guard
```

## Notes

- Registering a policy without its stream is safe: the drift gate only compares bindings that
  exist; task 04 must land before any client relies on these rows.

## Evidence (2026-10-28)

- `packages/content/src/policies.ts`: `CAMPAIGN_ENTITY_POLICY`, `PERSONAL_NOTE_POLICY`.
  `packages/content/src/visibility-adapters.ts`: `EntityVisibilityAdapter`,
  `personalNoteFactsSource` (exported from `@rpg/content/postgres`).
- `apps/api/src/modules/sync/sync-rules.ts`: both policies in `REGISTERED_RESOURCE_POLICIES`;
  `registerResourcePolicies(registry, adapters?)`. `apps/api/src/runtime.ts`: content connection,
  adapter registered (`requireVisibilityAdapters: true`), personal-note facts source in
  `factsSources` (ContentAccess + AuditTargetAccess), connection closed on shutdown.
  `apps/api/src/modules/campaigns/access.test.ts` now builds a registry without the adapter
  requirement (campaign access only).
- `packages/content/src/policies.test.ts`: 7 pass (registration, missing role row x 5 roles x 2
  classes, `runPolicyConformance` both classes, `checkAuthorPrivate`, decision table, GM-only
  default per type).
- `packages/content/src/visibility-adapters.integration.test.ts`: 3 pass;
  `runVisibilityAdapterContract` 10 checks incl. `tombstone_excluded`, findings `[]`.
- `apps/api/src/modules/authorization/content-visibility.integration.test.ts`: runtime PATCH on
  `campaign_entity`: player 404 (= missing), reveal everyone, stale 409, un-reveal, targeted reveal and
  removal, exactly 4 `visibility.*` audit rows; `personal_note` 404 for author and owner, note
  unchanged.
- `apps/api/src/modules/audit/composition.test.ts`: `snapshotFor` is undefined (GM-only fallback)
  for both classes; recorder stores `gm_only` snapshots.
- `security-acceptance.test.ts` matrix now covers both classes (conformance, truth table, author-private).
- `bun test packages/content apps/api/src/modules/authorization apps/api/src/modules/audit
  apps/api/src/modules/campaigns --timeout 30000`: 153 pass, 0 fail.
- Gates (2026-10-28, with `.env`): `bun run check` clean (421 files); `bun run typecheck` 13/13
  workspaces exit 0; `bun run guard` 372 files, no violations; `bun run build` api and web exit 0;
  `bun test --timeout 30000` (with `POWERSYNC_ENGINE_EXEC`) 1316 pass, 0 fail (131 files); `bun run test:e2e` 64 passed.
