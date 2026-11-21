# Task 06: Reveal and un-reveal interface

Status: completed (provider verified 2026-10-26 at protocol/engine level (F04 task 05 "Provider round trip"); live per-row reveal awaits a replicated content class). UI, API-side acceptance, Playwright, and sync-side
delivery/removal evidence at the simulated-replica level are done. Depends on tasks 03–04.

## Scope

- Build generic Visibility controls and current-member target picker.
- Display conflicts and the prior-knowledge limitation of un-reveal.
- Keep unsupported party controls absent/fail-closed.
- Add component/Playwright tests for targeted reveal, additive repeat, and un-reveal.

## Acceptance Criteria

- Player A receives a reveal and player B receives no row/payload.
- Removing the last target stores `gm_only` and removes future/local access after sync.
- Unauthorized users cannot produce a visibility mutation by direct request.

## Verification

```bash
bun test apps/web/src/features/visibility apps/api/src/modules/authorization
bun run build
```

## Evidence

Files:

- `apps/web/src/features/visibility/`: `visibility-model.ts` (pure hints, request building,
  fail-closed response parsing, copy), `visibility-api.ts` (PATCH + current members read),
  `VisibilityControls.tsx` (`VisibilityPanel` presentational, `VisibilityControls` container),
  `e2e-harness.tsx` (Playwright-only host; not imported by production code).
- `apps/web/e2e/visibility.e2e.ts`.
- `apps/api/src/modules/authorization/visibility-acceptance.test.ts`.

Behavior:

- Controls render only for `owner`, `gm`, `assistant_gm` (`viewerRole` hint). The server still
  decides every change.
- Picker is fed by `GET /campaigns/:campaignId/members` (current memberships only, identity
  route) and offers players only; GM roles, observers and removed members are never offered.
- Reveal to selected players (additive), reveal to everyone, remove a single recipient,
  hide from everyone. Removing the last recipient yields the server's `gm_only`.
- A repeated reveal shows "Already revealed ... Nothing changed" (server `changed:false`).
- 409 shows a conflict panel; Reload asks the host to refetch; Retry stays disabled until the
  reload, then resubmits the same intent against the new version.
- 400 `target_not_member` clears the selection and refreshes the member list.
- 404 shows a copy that does not say whether the record exists.
- Un-reveal copy: access removed from now on, record leaves devices on next sync, anyone who
  already saw it keeps what they saw including copies or exports.
- `party` visibility renders read-only with no controls; the UI never builds a party request.

Commands run:

- `bun test apps/web/src/features/visibility apps/api/src/modules/authorization` (with `.env`):
  58 pass, 0 fail (22 web, 36 api; 7 of the api tests are new in `visibility-acceptance.test.ts`).
- `bun x playwright test apps/web/e2e/visibility.e2e.ts`: 8 passed.
- `bun run build`: web build exits 0. `bun run typecheck`: no errors. `bun run check`: 230 files
  clean. `bun run guard`: no violations.

Acceptance status:

- Player B receives no row/payload: proved at the API for the invented `fixture_note` class
  (reads and lists return bytes identical to before the reveal and to a missing record).
  Sync delivery (no row in Player B's replica) is NOT proved here.
- Last target removed stores `gm_only`: proved at the API (store value and Casey's read/list).
  "Removes local access after sync" is NOT proved here: needs task 05 predicate and task 07.
- Unauthorized direct PATCH: proved (player, observer, outsider, anonymous: 404/401, record,
  write count and audit unchanged).

## Gaps

- The controls are not mounted in a production screen: no production content class or record
  read exists. The first content owner mounts `VisibilityControls` and supplies `visibility`,
  `version`, `onChanged` and `onReload`.
- Fixed 2026-10-26: the members routes accept `cursor`/`limit` and the picker (and
  `CampaignAdmin`) read every page through `apiRequestAllPages` (`apps/web/src/api.test.ts`).
- Playwright uses a route mock of the PATCH contract, not the real API (the web e2e server does
  not run the API). Real route behavior is covered by the API tests.

## Sync-side evidence (task 07)

- "Player B receives no row": `apps/api/src/modules/authorization/security-acceptance.test.ts` evaluates the
  compiled sync predicate (task 05) over server rows after real PATCH reveals: Casey's simulated replica
  gains the row, Rowan's stays empty; the 9-requester truth table delivers no GM-only, foreign-private,
  other-campaign or observer row to a player. Task 05 adds PostgreSQL SQL replica flows
  (`packages/sync/src/infra/postgres/sync-rules.integration.test.ts`): reveal delivers to Casey only, no Rowan
  payload carries the id, hidden inserts leave Rowan's payload byte-identical.
- "Un-reveal removes local access after sync": after PATCH unreveal the predicate no longer matches for
  Casey (the provider diff is a REMOVE; task 05 SQL flow asserts the REMOVE), GM replica keeps the row.
- Provider (2026-10-26): PowerSync 1.25.0 accepts the compiled rules; its own sync-rules engine
  agrees with `decide` over the fixture truth table (targeted, author-private), and live
  `/sync/stream` tests show a visibility narrowing as a REMOVE and no op for unseen tombstones
  (with `campaign_settings.member_visible`). A live per-row reveal awaits a replicated content class.
- Remaining gaps (not acceptance blockers): no production mount point or content class; members route
  paging fixed 2026-10-26; Playwright mocks the PATCH contract; offline visibility mutations bypass this route.
