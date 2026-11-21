# Task 05: Offline attachment store and campaign pinning

Status: completed (2026-10-27), against feature 04 fixture owner classes. Attachment metadata
reaches the device through the authorized offline set, not through PowerSync (see Deviations).
Depends on task 04 and feature 03.

## Scope

- Implement device-local state/byte store, atomic verified download, cache vs pin semantics.
- Add campaign estimate/confirmation/progress UI with bounded download concurrency.
- Handle restart, interruption, unavailable state, visibility removal, membership revocation, and sign-out.
- Test exact payload estimate tolerance and no duplicate unchanged bytes.

## Acceptance Criteria

- [x] Nothing downloads before explicit confirmation.
- [x] Every reported pinned attachment opens offline after restart.
- [x] Revocation removes local metadata/bytes on observed synchronization and aborts downloads.

## Verification

```bash
bun test packages/attachments apps/web/src/features/attachments
bun run build
```

## Evidence

- `packages/attachments/src/offline.ts` (entry `@rpg/attachments/offline`, browser-safe):
  `OfflineAttachmentStore` with ports `OfflineAttachmentDb` (record + bytes, atomic) and
  `OfflineAttachmentSource` (authorized network path). `plan()` reads the offline set and returns
  the estimate (exact payload bytes of visible attachments without matching local bytes) and
  downloads nothing; `pin(plan)` is the confirmation: pin intent per attachment, matching local
  bytes promoted (no second copy), the rest downloaded with bounded concurrency (default 3),
  verified (size + SHA-256 against the authority's checksum) and only then written with the
  `pinned` state in one atomic step. `start()` resets interrupted downloads (no partial bytes ever
  stored; pin intent kept), `resume()` re-downloads them. `cache()`/`evict()` implement evictable
  cached copies (LRU; pinned never evicted). `openLocal()` re-verifies the checksum, and when online
  asks the read route first (a denial removes the copy). `availability()` derives `unavailable`
  (no local bytes, no network). Removal signals: `replicaPurged` (it is a feature 03
  `ReplicaPurgeListener`), `reconcile`/`reconcileAll` (absent from the offline set → metadata and
  bytes removed, downloads aborted; 404 → campaign purged; offline → no change), `clear()`
  (sign-out). A purge generation counter stops any download that started before the purge from
  writing afterwards.
- `apps/web/src/features/attachments/offline-db.ts`: `IndexedDbOfflineAttachmentDb`, one database
  per user (`rpg-attachments-<userId>`), `records` + `bytes` stores written in one transaction.
- `apps/web/src/features/attachments/offline-source.ts`: offline set from the API, each download
  asks for a fresh five-minute read grant and fetches it from the storage origin with
  `credentials: 'omit'`, `no-referrer`, `cors`, `no-store`; 404 = denied, any other failure is
  retryable and never permission; unsafe grant URLs (same origin, `blob:`, `javascript:`) refused.
- `apps/web/src/features/attachments/OfflineAttachments.tsx`: "Make available offline" → estimate
  dialog ("Download N attachments (X MB) to this device?", Download / Not now) → progress
  (`<progress>`, count and bytes) → result; list with availability per attachment. Local content
  opens inert only: images through `<img>` from a typed local blob, PDFs only as a download.
- `apps/web/src/features/sync/useBrowserSync.ts`: opens the user's store beside the replica,
  passes it to `BrowserSyncSession` as a purge listener, reconciles on observed synchronization
  (throttled to once per 30 s), and `signOut` also clears it. `CampaignDashboard.tsx` mounts the
  panel in an "Offline attachments" `<details>`.
- API: `GET /campaigns/:campaignId/attachments/offline-estimate` → `{ items, totalBytes }`
  (`no-store`; `AttachmentService.listCampaign`: one fresh decision per owner, narrowed per
  attachment; non-members get the safe 404). Repository `listReadyInCampaign`.

Tests (with `.env`):

- `packages/attachments/src/offline.test.ts` (19): estimate before download and dismissal, progress
  and bounded concurrency, exact estimate within max(1 MiB, 1%), repeat pin makes no copy, cached →
  pinned without download, only returned attachments stored, corrupted/failed downloads keep
  nothing partial, interrupted download resumes after restart, pinned opens offline after restart
  with no request, cached stays cached, unavailable vs cloud only, tampered bytes dropped, online
  denial removes, LRU eviction never touches pinned, narrowing/deletion reconcile, offline
  reconcile changes nothing, revocation purge aborts downloads (other campaign untouched), denied
  download stores nothing, sign-out clears all.
- `packages/attachments/src/deletion.test.ts` offline-set block (4) and
  `apps/api/src/modules/attachments/offline-deletion.routes.test.ts` (2 of 7): per-actor
  filtering, one decision per owner, non-member 404, pending/failed/deleted excluded, empty with no
  registered owner class.
- `apps/web/src/features/attachments/offline-source.test.ts` (4).
- `apps/web/e2e/attachments-offline.e2e.ts` (6, real IndexedDB, real MinIO bytes): estimate first
  and dismissal downloads nothing; confirm with progress, estimate exact (`actual == estimate`),
  repeat costs nothing; restart + `context.setOffline(true)`: pinned PNG renders from a `blob:`
  image, PDF arrives as a download, no API or storage request, still cross-origin isolated, no
  dialog; failed download reports unavailable offline and "Preview unavailable." without breaking
  the page; narrowing, a denied read and revocation (404 offline set) remove records and bytes;
  `replicaPurged` during a held download aborts it and leaves nothing.
- `apps/web/e2e/live-sync.e2e.ts` (+1, +1 assertion): revocation through the live PowerSync
  provider removes the revoked campaign's pinned attachment (record and bytes) and keeps the other
  campaign's; dashboard logout leaves no attachment record or byte.
- Mutation checks: disabling the reconcile removal fails the narrowing unit test; removing the
  listener and the sign-out clear from `useBrowserSync` fails the dashboard logout e2e; removing the
  per-attachment narrowing in `listCampaign` fails 2 tests.
- `bun test packages/attachments apps/web/src/features/attachments`: 141 pass, 0 fail.
  `bun run build`: exit 0.

## Deviations (recorded in `_db.md` and `_techspec.md`)

- Metadata does not replicate through feature 03. A sync rule for attachments needs the owner's
  decision, i.e. a join to a per-record owner table; PowerSync 1.25.0 does not enforce equality
  between a joined row and the source row and hits the 1000-parameter limit on unkeyed joins
  (`docs/OFFLINE_SYNC_RUNTIME.md`, Audit stores). With no production owner class either, the
  `attachments` table stays out of the `powersync` publication (asserted by
  `retention.integration.test.ts`). The device keeps metadata only for attachments an authorization
  decision returned, next to their bytes, and drops both on the removal signals above.
- Device state lives in IndexedDB beside the replica (not in the replica's SQLite), so a verified
  download and its state commit atomically, and purge runs through `ReplicaPurgeListener`, the
  contract feature 03 defines for local state outside the replica.

## Open

- No production owner class (feature 16): in production the offline set is always empty.
- A device offline at revocation keeps its bytes until it reconnects (as `_db.md` states).
- Installed-PWA restart from the service worker is not exercised (the specs block service workers;
  the restart is a page reload with the network down). Edge headless only.
- Pinning a campaign does not auto-download attachments added later; they appear as cloud only
  and the next "Make available offline" estimates them. Per-attachment pin/unpin UI is P1.
- `navigator.storage.persist()` is requested best effort on confirmation; browser eviction under
  storage pressure is not controlled beyond that.
