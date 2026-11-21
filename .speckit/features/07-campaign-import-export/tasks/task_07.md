# Task 07: Portability UI, fuzzing, and round-trip acceptance

Status: completed (2026-10-28). Export half (2026-10-27) and import half (2026-10-28) both have
acceptance evidence below. Depends on tasks 04–06.

## Scope

- Build export warning/progress/download and import validation/result/warning interfaces.
- Run campaign round trip across every registered P0 contributor and visibility mode.
- Fuzz ZIP/JSON boundaries and test unavailable system, unknown chunks, rollback, and deliberate duplicate import.
- Verify guard independence and full repository gates.

## Acceptance Criteria

- Round trip preserves recognized logical counts, exact pins, and never widens visibility.
- Unknown/unrestored data is explicitly reported; no silent discard.
- Orchestrator contains no imports of content-feature internals.

## Verification

```bash
bun run check
bun run typecheck
bun test
bun run guard
bun run build
```

## Export-half evidence (2026-10-27)

- **Export UI.** The warning, acknowledgment, status and download are built in
  `apps/web/src/features/portability/CampaignExport.tsx` and mounted on the dashboard.
  `apps/web/e2e/portability.e2e.ts` passes 4 tests: warning before export, a valid downloaded
  package, denial, and the offline refusal or offline package.
- **ZIP/JSON fuzzing.** `packages/campaign-portability/src/inspector.test.ts` covers seeded
  mutation fuzzing and every hostile-package defect (task 02).
- **Guard independence.**
  - Guard rule `no-portability-feature-imports`.
  - The `orchestrator.test.ts` import scan: the orchestrator imports only `@rpg/contracts`.
- **Visibility.** Export serializes Visibility as stored (`gm_only`, `players` targets), shown in
  `campaign-export.integration.test.ts`.
- **Then still needed (done 2026-10-28, below):** the import UI, the round trip, the
  unavailable-system and unknown-chunk reports, the rollback, and the duplicate import.

## Import-half evidence (2026-10-28)

- **Import UI.** `apps/web/src/features/portability/CampaignImport.tsx` + `import-client.ts`,
  mounted on the campaign dashboard (the list refreshes after an import). It sends the file once
  under a client job id and explains the server's report: restored counts per module, every
  warning in words (binaries not restored, visibility narrowed, settings not restored), preserved
  chunks with their reason, and rejections (exact unavailable system/module pins, contributor
  failures, invalid file). It never displays package text. Offline it refuses without a request.
- **Round trip** (`apps/api/src/campaign-import.integration.test.ts`, runtime + PostgreSQL):
  export → import → the restored campaign equals the source on name, description, system, game
  mode, module pins and settings; the importer is the sole owner; the source owner and player get
  404; re-export has a canonically equal `campaign` chunk and equal locks. Documented exclusions:
  attachment rows (no binaries; reported), memberships, audit (one `campaign.imported` event on
  the new campaign).
- **Browser round trip** (`apps/web/e2e/portability-import.e2e.ts`, real API over PostgreSQL in
  `e2e/fixtures/portability-api-server.ts`): export download → upload → report → API check of the
  new campaign and its sole owner (5 tests: round trip, unknown chunk shown but never rendered,
  unavailable system, hostile file, offline).
- **Unknown chunks:** reported and preserved; re-export re-emits them under `unknown/` with equal
  canonical checksums; a second import keeps them preserved.
- **Unavailable system:** blocks before write with the exact pins, never a newer installed version.
- **Rollback:** a failing contributor (err or throw) after a contributor already wrote leaves no
  campaign, owner, contributor row or preserved chunk; the job fails with the module id and only
  a safe code.
- **Idempotency / duplicate import:** retrying a job id returns the same job and creates nothing;
  another user's reuse is a 404; a deliberate second import creates a distinct campaign and leaves
  the first unchanged.
- **Fuzzing:** 7 targeted defects (malformed container, CRC, invalid root, undeclared module pin,
  unavailable module lock, duplicate attachment ids, invalid manifest) plus 40 seeded mutations
  (flips, truncations, splices) through the HTTP route: every rejected package left campaigns,
  memberships and preserved chunks unchanged; any mutation that survived inspection imported
  completely. The inspector's own fuzzing (task 02) stays in place.
- **Guard independence:** rule 11 still holds (the portability package imports only
  `@rpg/contracts`); feature contributors arrive through the registry.

### Verification (with `.env`)

| Command | Result |
| --- | --- |
| `bun run check` | clean (392 files) |
| `bun run typecheck` | 12/12 workspaces exit 0 |
| `bun test --timeout 30000` | 1227 pass, 8 skip, 0 fail (1235 tests, 120 files) |
| `bun run guard` | 346 files, no violations |
| `bun run build` | api and web exit 0 |
| `bun run test:e2e` | 64 passed (59 earlier + 5 import) |
