# Task 08: Sync status, browser acceptance, and performance

Status: completed (2026-10-30), owner decision: manual and real-device checks become automated tests or are
dropped. The automated browser matrix and the installed-app restart replace them. Offline flows of features
not built yet belong to those features. See "Open".

## Scope

- Complete synchronized/pending/offline/error status UI and initial-sync progress.
- Automate promised offline flows, restart, multi-client convergence, and failure injection.
- Measure cold-open p95 on the documented browser/device matrix and both storage backends.
- Document only verified runtime/startup requirements.

## Acceptance Criteria

- [x] Status never says synchronized while pending/error work exists.
- [x] All P0 offline flows that exist stay usable and converge after reconnect. Each later feature adds its
  own flow to its acceptance.
- [x] A warm replica reaches usable content under two seconds on the accepted matrix. Session Mode itself does
  not exist yet; feature 18 owns that screen.

## Verification

```bash
bun run check
bun run typecheck
bun test
bun run guard
bun run build
```

## Progress (2026-10-26)

### Status

- `SyncStatusStore` (`packages/sync/src/status.ts`):
  - Precedence: error > offline > pending > synchronizing > synchronized. Error includes
    unresolved conflicts (`unresolved_conflicts`).
  - New `synchronizing` state while `initialSyncProgress` is set.
  - `SyncStatus` gains `synchronizing` and `unresolvedConflicts` (`model.ts`).
- `syncStatusLabel` / `SyncStatusIndicator` (`apps/web/src/features/sync/SyncStatus.tsx`):
  - labels: "Synchronizing — N%" and "Sync error — N pending, M unresolved";
  - attributes: `data-sync-state`, `data-pending-count`.

### Browser read path (`packages/sync/src/browser.ts`, `@rpg/sync/browser`)

- `BrowserSyncSession`:
  - opens one replica per user before any network request;
  - maps provider status, `navigator.onLine`, queue and conflict counts to the status store;
  - after each consistent checkpoint, feeds the replicated memberships to
    `ReplicaAccessReconciler.applyMemberships(..., { complete: true })`;
  - `signOut` purges every campaign and clears the replica;
  - when every bootstrap candidate is denied, it clears provider data
    (`disconnectAndClear({ clearLocal: false })`).
- `BrowserReplicaStore` and `BrowserReplicaManager`: the reconciled membership cache
  (local-only `sync_membership_cache`), local-first writes (replica row plus queued mutation in one
  transaction), ordered batches, outcomes, conflicts, and purge of local-only state.
- `RegisteredPowerSyncConnector`:
  - Credentials: tries candidate campaigns in order; a `404` triggers `accessDenied`.
  - Upload: sends the registered batch and completes PowerSync's queue only when nothing is left.
    A transport failure or a retryable outcome throws, so the retry reuses the same mutation ids.
- `ReplicaAccessReconciler` moved to `replica-access.ts` (provider-neutral, async store ports).
  It is still exported from `@rpg/sync/bun`; `actor()` stays synchronous for the Bun store.

### App composition

- `useBrowserSync` (`apps/web/src/features/sync/useBrowserSync.ts`): the dashboard header shows
  the live status, and logout calls `signOut`.
- `vite.config.ts` sets `worker.format: 'es'`: the production build bundles the web SDK.

### Evidence

All commands ran with `.env`.

- `bun run test:e2e -- apps/web/e2e/live-sync.e2e.ts`: 7 pass against the live service.
  `--repeat-each=3`: 21/21. Without `DATABASE_URL`: skipped. The cases:
  - Player visibility, revocation while connected, and sign-out. A mutation that disables the
    reconciler fails this test.
  - Revocation while offline, then reconnect.
  - Offline edits: restart, causal drain, and convergence on a second browser context.
  - Failure injection: HTTP 500, lost acknowledgement, retryable outcome, deferred conflict.
  - A revoked member's queued write is not applied and leaves the device.
  - Cold-open p95.
  - Dashboard status and logout. Disabling `signOut` fails this test.
- Cold-open p95 of a warm replica (200-setting campaign, 20 reopens, database creation to first
  campaign and settings reads):
  - Edge 156 headless: OPFS 126.5 ms, IndexedDB 44.3 ms.
  - Chromium headless shell 151: OPFS 127.9 ms, IndexedDB 45.8 ms.
  - Table and conditions: `docs/OFFLINE_SYNC_RUNTIME.md`, "Browser replica through the web SDK".
- `bun run test:e2e` (full): 33 pass.
- `bun test --timeout 30000`: 890 pass, 7 skip (engine opt-in), 0 fail, 82 files.
- `bun run typecheck`: 10/10 workspaces exit 0.
- `bun run check`: 262 files clean.
- `bun run guard`: 224 files, no violations.
- `bun run build`: api and web exit 0.

## Installed app and browser matrix (2026-10-30)

### A defect this found

A signed-in member reopening the app at `/` landed on the login form, so offline they could never reach their own
replica: every earlier restart test used a harness. Fixed by `features/identity/device-session.ts`, which remembers
the user and last campaign ids (identifiers only, never a credential). Sign-out forgets them; a rejected session
(`unauthenticated`) returns to the login form with the replica intact. Also fixed: the production manifest declared no
icons, so the app was not installable; and the description editor overflowed a phone screen, which blocked taps.

### Evidence

- `apps/web/e2e/pwa.e2e.ts`, the production bundle with its service worker, the real API, and PowerSync:
  - Chromium's own installability check reports no errors (Edge only: the headless shell never answers it).
  - Offline, the shell and worker assets load from the service worker, still `crossOriginIsolated`.
  - Real login, then offline cold start to replica content in 272–643 ms (under the two-second budget), an offline
    write, a second offline restart with the queue intact, reconnect, and convergence on the authority.
  - Sign-out forgets the device; a rejected session returns to login.
- `bun run test:e2e:matrix` (`playwright.matrix.config.ts`): the whole suite on mobile Chromium (Pixel 7) here, and
  Firefox 153, WebKit 26.5, and WebKit as iPhone 15 on Linux in the official Playwright image
  (`docker compose --profile e2e-browsers up -d playwright-browsers`, published on loopback only).

Warm replica cold open p95, 200-setting campaign, real sync, 20 reopens:

| Browser | OPFS | IndexedDB |
| --- | --- | --- |
| Edge 156 | 306.4 ms | 73.7 ms |
| Chromium 151, Pixel 7 emulation | 153.3 ms | 55.7 ms |
| Firefox 153 on Linux | 620.9 ms | 160.7 ms |
| WebKit 26.5 on Linux | no OPFS: IndexedDB fallback | 459.9 ms |

### Results and honest limits

- Last full run (82 tests per project): Firefox 77 passed, 5 skipped; WebKit 75 passed, 7 skipped; mobile WebKit
  76 passed, 6 skipped; none failed. Daily Edge run: 81 passed, 1 skipped (the phone-only test).
- **Open, cause unknown:** on mobile Chromium the import round trip failed in 4 of 5 full runs ("The server could not be
  reached", 75 passed, 1 failed, 4 not run after it in that serial file). The one passing full run had
  temporary logging added, and 4 of 4 repeated alone, so timing is a suspect but nothing is proven. No other project
  shows it.
- Failures that were the tests, not the product: a corrupt PNG fixture only Chromium tolerated; tests forcing OPFS
  where it does not exist; Playwright not exposing Blob request bodies to routes.
- Skipped on purpose, because of Playwright rather than the app: the offline restart on Firefox and WebKit (they refuse
  offline navigations a service worker should answer); the shell-offline test on WebKit; `setOffline` on WebKit in the
  pinned-attachment test (it fails `blob:` loads, which use no network); PDFs on engines with no viewer; the network
  profile test off Chromium. **So the offline restart through a service worker is proven on Chromium engines only.**
- WebKit on Linux is the engine, not Safari, and phone projects are emulation. Real devices are dropped by owner
  decision, not verified.
- Sync reaches WebKit about 25 s late under Playwright, so the matrix allows 90 s per sync wait. Whether that is Playwright
  or the engine is not established.

## Closed since the first pass

- Browser conflict-resolution actions and the deferred-conflict local value: `ConflictSurface` and "Resubmit mine" /
  "Keep authority" through `content.e2e.ts` (feature 16).
- `@rpg/identity` browser-safe entry: `@rpg/identity/browser`.

## Left as is

- Offline flows of sheets, dice, rules, encounters, and resources: each owner adds its flow to its own acceptance.
- The production precache holds the SDK's bundled worker and WASM chunks the app does not load (it uses
  `/sync-assets/`). Harmless bytes, about 19 MB precached in total.
