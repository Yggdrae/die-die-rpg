# Task 06: Offline creation and synchronized campaign repository

Status: implemented; provider round trip unverified. Local adapters, creation and setting appliers, and the composition glue are done and tested against the real authority (runtime + PostgreSQL). Rows reaching the device through a running PowerSync service (membership/campaign tombstones, bootstrap) are not evidenced: the reconciler is fed rows read from PostgreSQL. That gap belongs to feature 03 tasks 04/07 (open) and is the only reason this is not `completed`.

## Scope

- Implement campaign/settings local schemas and `SyncedRepository` adapters.
- Record the creation aggregate atomically with stable client IDs and causal upload grouping.
- Queue invitations only after campaign acceptance; never report offline invitations delivered.
- Test restart durability, reconnect idempotency, conflict, and tombstone behavior.

## Acceptance Criteria

- [x] Offline-created campaign is immediately readable and converges with identical IDs/pins.
- [x] No partial aggregate reaches authority or survives a rejected creation.
- [x] Membership revocation/campaign deletion removes local context. Local destruction and the authority facts that trigger it are proven against the real authority; provider delivery of those rows is tracked by feature 03 task 04 (see Open).

## Verification

```bash
bun test packages/campaigns packages/sync
bun run typecheck
```

## Progress (2026-10-25)

Composition (provider-neutral; no browser composition of `MutationQueue`/`ReplicaAccessReconciler` exists yet, they are `@rpg/sync/bun` only):

- `CampaignReplicaSync` (`packages/campaigns/src/offline-sync.ts`, structural types, no `@rpg/sync` import). The device composition calls:
  - `afterDrain(report)` after every `MutationQueue.drainWithOutcomes`: in causal order, `accepted` + `campaigns`/`campaigns` + `insert` (record = campaign) -> `OfflineCampaignRepository.authorityAccepted`; `accepted` campaign `tombstone` -> `ReplicaAccessReconciler.campaignDeleted`. Conflict/rejected/retry/offline do nothing. Handler failures are returned in `errors` and never stop later items.
  - `serverCampaigns(rows)`: a delivered tombstoned `campaigns` row -> `campaignDeleted`.
  - `bootstrapDenied(campaignId)` (bootstrap 404) -> `accessDenied`.
  - `resumeAccepted(campaignId, store.hasAcceptedCreation)` on startup: closes the window where the process stops after the accepted outcome was persisted but before `afterDrain` released invitations. Idempotent (intent IDs).
- `SqliteReplicaStore.hasAcceptedCreation` (`packages/sync/src/bun-sqlite.ts`): persisted accepted creation mutation; false for queued or rejected.
- Mapping fix (`apps/api/src/modules/sync/campaign-applier.ts`): conflict outcomes no longer fabricate `expectedVersion: 0` (wire schema requires >= 1). Campaign update/tombstone with no base version -> `invalid_campaign_mutation` (malformed, not a conflict); a first setting write (null base) colliding with an existing setting -> terminal `setting_already_exists`. Real conflicts echo the client's version. Semantic ops (`packages/sync/src/semantic.ts`) keep the same `?? 0` pattern for absolute-set ops with a null base; not changed (feature 03 scope).

Evidence (`bun test packages/campaigns packages/sync apps/api --timeout 30000`: 195 pass; typecheck, `check`, `guard` clean; `bun run test:e2e` 18 pass; no browser composition to drive, so no new Playwright spec):

- Readable immediately, identical IDs/pins, restart durability, reconnect idempotency (`apps/api/src/offline-campaign.integration.test.ts`: real HTTP `POST /sync/mutations`, creation scope, membership resolution, PostgreSQL): "creation is readable at once, converges with identical IDs and pins, and survives restart and replay" (authority 404 before upload; one campaign, system pin, module pin, owner membership after; replayed batch accepted without duplicates). Unit level: `campaign-applier.test.ts` "survives restart and converges with identical IDs and pins exactly once".
- No partial aggregate, nothing queued: "rejected creation leaves no partial aggregate at the authority and queues nothing" (0 rows in all four tables; squatting on an existing ID is `not_found_or_forbidden` and changes nothing). Unit: "rejected or denied creation queues no invitation and leaves no authority aggregate".
- Invitations only after acceptance, never delivered offline, once: "invitations queue only after authority acceptance, never offline, once per intent"; the integration test shows the real invitation endpoint 404s before upload and 201s after; "restart after acceptance but before dispatch still releases invitations exactly once"; `offline.test.ts` "campaign replica sync dispatch" (3 tests).
- Conflict: "stale offline edit becomes a deferred conflict; the authority value stands"; "conflict outcomes never reach acceptance handlers"; "conflict outcomes always carry a real base version (>= 1)".
- Revocation: "membership revocation removes local context and the authority refuses the stale edit" (ownership transfer and removal on the real authority; membership tombstone row -> `applyMemberships` -> purge, queue cleared; forced stale upload -> `not_found_or_forbidden`).
- Deletion/tombstone: "campaign deletion removes local context whether made on the device or elsewhere" (accepted tombstone outcome purges; unconfirmed local delete does not; server `deleted_at` row -> purge); "server campaign tombstone destroys local context; live rows and local-only deletes do not"; "bootstrap denial keeps an unaccepted creation and drops an accepted replica".

## Open

- Provider round trip (PowerSync service not running locally; images not pulled): membership and campaign tombstone rows reaching a device through the service. Tracked by feature 03 task 04 (its criterion, not this task's). Feature 03 tasks 01/04/07 deliver the contract, per-mutation outcomes, `current_user_memberships` stream and `ReplicaAccessReconciler` used here.
- A browser read adapter calling `CampaignReplicaSync`/`ReplicaAccessReconciler` (see next item).
- No browser composition of the queue/reconciler (`MutationQueue` is Bun SQLite only), so no Playwright spec for offline creation.
- `GET /sync/bootstrap/:campaignId` still answers 200 for a soft-deleted campaign while the member is active; deletion reaches devices only through the tombstone row. Feature 03 decision whether bootstrap should deny.
- A creation rejected by the authority stays visible locally (sync status `upload_rejected`, mutation state `rejected`) until bootstrap denial destroys it (`hasPendingCreation` excludes rejected). No explicit discard or edit-and-retry path yet.
- Semantic-op conflicts with a null base still report `expectedVersion: 0` (feature 03).
