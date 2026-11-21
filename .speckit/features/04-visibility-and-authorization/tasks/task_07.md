# Task 07: Authorization guard and security acceptance

Status: completed (provider round trip verified 2026-10-26, see task 05; the attachment and export
gaps below were closed by features 05 and 07). Depends on tasks 04–06.

## Scope

- Extend guard rules/fixtures for local role checks, direct membership access, and unregistered content routes.
- Run BDD acceptance across API payloads, local databases, attachments, audit, and export.
- Add denial-telemetry aggregation tests without actor-level surveillance.
- Verify full repository gates.

## Acceptance Criteria

- Guard names the violating file/rule and sanctioned boundary.
- Validation campaign contains zero unauthorized GM-only/private rows on player devices.
- Every content class passes the shared matrix before route registration.

## Verification

```bash
bun run check
bun run typecheck
bun test
bun run guard
bun run build
```

## Evidence

Guard (`tools/guard/src/rules.ts`, fixtures in `rules.test.ts`, 90 tests pass):

- `no-local-role-checks`: role literal comparisons, literal-array `includes`, `switch (…role)` in non-test apps/packages code outside identity/authorization. Narrow allowlist with reasons: `CampaignAdmin.tsx` (UI hint), `visibility-model.ts` (member-row filter and hint). The pre-F04 writable-role gate in `packages/campaigns/src/application.ts` moved to
  `apps/api/src/modules/campaigns/access.ts` (feature 04 decision plus namespace writable roles)
  on 2026-10-26 and its allowlist entry was removed.
- `no-unsanctioned-content-routes`: routes under `/campaigns/:campaignId/resources/` or `contentRoute: true` in `apps/api` must pass `requireResource`/`requireCollection`. Static complement to the runtime inventory.
- Direct membership access outside identity: already enforced by `no-external-membership-store-access` and `no-membership-store-imports`; negative fixtures for content-module shapes added, no new rule needed.
- Each violation names file, rule, and the sanctioned boundary (AuthorizationService.decide / ContentAccess / ActorResolver).

Acceptance (`apps/api/src/modules/authorization/security-acceptance.test.ts`, 19 tests): conformance of `REGISTERED_RESOURCE_POLICIES` and fixture classes through `runPolicyConformance`, `syncTruthTable`/`findSyncDivergences`, `checkAuthorPrivate`; unguarded route fails `ready()`; simulated replicas (no GM-only/private rows to players, reveal/un-reveal diffs, hidden counts/tombstones); audit only on accepted mutations; attachment signed-URL gate via `authorizeResource`; denial telemetry (`denial-telemetry.ts`, class+reason only, wired in `runtime.ts`).

Gates (with .env): `bun run check` clean (240 files), `bun run typecheck` 10/10, `bun test --timeout 30000` 805 pass 0 fail 70 files, `bun run guard` 204 files no violations, `bun run build` exit 0.

## Gaps

- When this task closed, no attachment store or export feature existed; only the delegation helper
  was tested. Closed later: feature 05 task 07 (`apps/api/src/modules/attachments/security.test.ts`)
  and feature 07 (`apps/api/src/campaign-export.integration.test.ts`, player denial in
  `apps/web/e2e/portability.e2e.ts`).
- PowerSync round trip verified 2026-10-26 (task 05 "Provider round trip"): engine truth table and
  live `/sync/stream` per role. Browser SQLite delivery through the web SDK was verified later by
  feature 03 task 07.
- Telemetry is aggregated in memory and not yet exposed through a metrics endpoint.

## Follow-up fixes (2026-10-26)

- `decide` and the in-process sync evaluator deny malformed owner-loaded facts
  (`invalid_facts`) instead of throwing; a corrupt stored Visibility now answers the safe 404,
  not 500 (`authorization.test.ts`, `apps/api/src/modules/sync/holds-access.test.ts`).
