# Task 07: Visibility rules, revocation, and tombstone watermarks

Status: completed (provider round trip and browser SQLite delivery verified 2026-10-26).
Revocation, replica drop, current-user
membership stream, watermark acknowledgement, and guarded (report-only) tombstone purge are
implemented and tested at queue/repository/route/PostgreSQL level. Feature 04 sync predicates are
compiled from the registered declarations, and every configured stream query agrees with the API
decision on simulated PostgreSQL replicas, through the PowerSync sync-rules engine, and through
the running PowerSync service (see "Provider round trip").

## Scope

- Compile/register feature 04 sync predicates and equivalence tests. **Done (feature 04 task 05
  compiler; platform queries derived here).**
- Implement replica drop on membership revocation/sign-out and reject queued writes. **Done.**
- Implement subscriber watermarks and guarded tombstone purge. **Done (report-only purge).**
- Test absence of hidden rows/counts/tombstones on player replicas. **Done (SQL on simulated
  replicas; live PowerSync replicas for settings, holds and memberships).**

## Acceptance Criteria

- [x] A revoked replica loses campaign data/pending work on reconnect.
- [x] No tombstone purges before every eligible subscriber condition holds and 90 days pass.
- [x] API and sync visibility matrices agree exactly. Proven in-process, as PostgreSQL SQL,
  by the PowerSync 1.25.0 sync-rules engine (exhaustive truth table) and on the live service.

## Verification

```bash
bun test packages/sync packages/authorization apps/api/src/modules/sync
bun run guard
```

## Progress (2026-10-25)

Server (`packages/sync`, `apps/api`):

- `DurableRevocationPublisher` (`revocation-delivery.ts`) implements
  `CampaignAccessRevocationPublisher`: durable outbox enqueue (idempotent by campaign, user,
  membership version, reason), one immediate attempt, then `retryDue()` / `startRetryLoop()` with
  exponential backoff; `pending → delivered | failed` after `maxAttempts` (10). Diagnostics
  `deliveryRetrying`/`deliveryFailed` (IDs, version, reason, attempt, safe code); `backlog()`.
  Only an outbox write failure throws (feature 01 logs `integrationDegraded`). Membership is
  never restored or touched.
- PostgreSQL adapters (`infra/postgres/store.ts`): `PostgresRevocationDeliveryOutbox`
  (`sync_access_revocations`), `PostgresReplicaSubscriptionStore` (`sync_replica_subscriptions`;
  bootstrap registry and the production `ConnectedAccessInvalidator`: `removed`/`signed_out`
  revoke every subscription made at or before `committedAt`; role/ownership changes only
  re-filter), `PostgresWatermarkStore` (monotonic, user-guarded, stores `pending_record_ids`;
  local-cleanup ack revokes the subscription), `PostgresTombstonePurgeEvidence`
  (`TombstonePurgeEvidence` via `decideTombstonePurge`).
- `reportTombstonePurge` is report-only: it classifies candidates and deletes nothing. Identity
  membership tombstones stay indefinite (feature 01 `_db.md`; contract note still unratified).
- `GET /sync/bootstrap/:campaignId?replicaId=` reuses a stable device replica id and registers
  the subscription after the access check. `POST /sync/replicas/:campaignId/ack` accepts
  optional `pendingRecordIds` (≤ 1000).
- 2026-10-28 (feature 06 retention follow-up): audit scopes (`audit_campaign_events`,
  `audit_private_events`) acknowledge with `{ replicaId, tableName, throughEventId }` instead of a
  raw `sequence` (a raw audit sequence is a 400); the API resolves the event to its sequence when
  the user may read it. `PostgresTombstonePurgeEvidence` takes an optional
  `ReplicaScopeEligibility`, so replicas that cannot receive a scope (players for the GM-private
  audit store) are not its subscribers.
- `apps/api/src/runtime.ts` wires the durable publisher by default
  (`modules/sync/revocation.ts`); `integrations.revocations` still overrides it;
  `revocationRetryIntervalMs` (default 30 s).
- Migration `0005_sync_revocation_delivery` (forward-only): the two tables plus
  `sync_replica_watermarks.pending_record_ids`. None is published.
- `infra/powersync/sync-config.yaml` stream `current_user_memberships`: requester's own rows
  only (`m.user_id = auth.user_id()`), tombstones included, exactly the `_db.md` cache fields.

Device (`@rpg/sync/bun`, provider-neutral):

- Local schema v2: `sync_campaign_state.replica_id`, `sync_membership_cache`.
- `ReplicaAccessReconciler(store, replicas, reconcile)`: `reconcile` is injected (identity's
  `reconcileMembershipCache`). `applyMemberships(userId, rows, { complete })`: replace/keep/remove;
  tombstone or absence from a complete set of an authority-confirmed campaign purges it; foreign
  rows ignored. `accessDenied` (bootstrap 404) keeps an unaccepted offline creation.
  `campaignDeleted` only after authority confirmation. `actor()` resolves offline roles.
- `ReplicaManager.purge(campaignId, reason)` drops all campaign-local tables before notifying
  `ReplicaPurgeListener`s with `ReplicaPurged`; listener errors are returned, never undo the drop.
  `access_revoked` leaves a cached tombstone, so local writes are refused
  (`not_found_or_forbidden`) and stale lower versions cannot restore access. `signOut()` purges
  every campaign and clears the cache.

Tests: `packages/sync/src/revocation.test.ts`,
`packages/sync/src/infra/postgres/revocation.integration.test.ts`,
`publication.integration.test.ts` (membership stream shape),
`apps/api/src/modules/sync/campaign-applier.test.ts` (identity reconcile + offline campaigns),
`routes.test.ts`, `apps/api/src/membership-revocation.integration.test.ts` (runtime default
publisher delivers and revokes subscriptions).

## Visibility evidence (2026-10-26)

Feature 04 delivered the compiler and the equivalence suite (feature 04 task 05). This task adds
the platform queries.

- Compiled predicates:
  - `compileProviderQueries` (`packages/sync/src/sync-rules.ts`) compiles the registered
    `REGISTERED_RESOURCE_POLICIES` (`apps/api/src/modules/sync/sync-rules.ts`), which
    `apps/api/src/runtime.ts` also registers.
  - The `campaign` stream query in `infra/powersync/sync-config.yaml` is that compiled output,
    and the drift gate (`apps/api/src/modules/sync/sync-config.integration.test.ts`) enforces it.
- Equivalence: `syncTruthTable`/`findSyncDivergences` (`packages/authorization`) and the
  PostgreSQL SQL truth table (`packages/sync/src/infra/postgres/sync-rules.integration.test.ts`)
  return no divergence for 5 fixture classes × 9 requesters × 520 rows, tombstones included.
- Absence on player replicas (`sync-rules.integration.test.ts`, simulated provider diff):
  - a GM-only row and an unseen tombstone are absent;
  - 25 hidden inserts and deletes leave the player payload byte-identical (counts);
  - un-reveal removes the row;
  - author-private rows never reach a GM.
- Platform queries (new). `campaign_settings` and `sync_long_text_holds` are not Resource
  Classes, and before this change neither filtered by reading role.
  - Both now carry the campaign class's reading-role scope
    (`m.role IN ('owner', 'gm', 'assistant_gm', 'player')`), so observers are excluded as the API
    excludes them.
  - Settings that are not member-visible follow `gm_only`.
  - Holds replicate only for campaign-wide classes (`h.resource_class IN ('campaign')`). A hold
    names its record, so a hold on a hidden record would otherwise leak that record's id. A class
    with per-record visibility must add a hold rule joined to its own predicate before its holds
    replicate. Until then this fails closed.
  - The drift gate derives both filters from the registered declarations and
    `AuthorizationService.decide`, and reports 4 tampered variants.
  - A new PostgreSQL test runs every configured stream query verbatim, with `auth.user_id()`
    bound as `$1`. It runs against rolled-back, session-local shadow copies of the real tables,
    which have the real columns but no role CHECK, so observers are representable.
    - Requesters: owner, gm, assistant_gm, player, observer, removed gm, non-member, and an
      other-campaign owner.
    - For each requester and table, the delivered ids equal `decide`, tombstones included: a
      GM-only setting reaches no player, and the hidden-class hold reaches no one.
    - Mutation check: removing the hold class filter fails both the drift test and this test.
- Purge and watermark reports reveal nothing to players:
  - `reportTombstonePurge` has no route;
  - `POST /sync/replicas/:campaignId/ack` answers `204` with an empty body;
  - the bootstrap response schema is `additionalProperties: false` with no counts.
- Commands (with `.env`):
  - `bun test packages/sync packages/audit packages/authorization apps/api --timeout 30000`:
    384 pass, 0 fail, 37 files.
  - The drift file with an unreachable database: 5 pass, 2 skip (CI path).
  - `bun run typecheck` 10/10, `bun run check` 240 files clean, `bun run guard` 204 files, no
    violations.

## Provider round trip (2026-10-26)

PowerSync Service 1.25.0 and MongoDB 7 ran from `compose.yaml` (Docker in WSL). Details:
`docs/OFFLINE_SYNC_RUNTIME.md`, "PowerSync 1.25.0 dialect" and "Provider checks".

- The configuration written before this run was rejected by the service: tuple `IN (...)` lists
  and `concat` are unsupported, and source aliases renamed the synced tables (`c`, `s`, `h`,
  `m` instead of the client table names). The adapter now renders unaliased sources and
  JSON-array value sets (`IN '[...]'`); the YAML uses `||`. MongoDB had to run as a replica set.
- `apps/api/src/modules/sync/sync-config.powersync.integration.test.ts`: 4 pass against the
  live service (stable over 10 runs). Real `/sync/stream` protocol, HS256 tokens like the API,
  write-checkpoint barrier. Per requester (owner, gm, assistant_gm, player, removed gm,
  non-member, other-campaign owner) the delivered campaigns, settings, holds and own memberships
  equal `decide`, tombstones included. Promotion/demotion add and remove GM-only settings;
  revocation removes every campaign row and delivers the membership tombstone; hidden-setting
  churn leaves a player's ops, counts and checksums unchanged; un-reveal of a setting is a
  REMOVE. A mutated settings filter fails 3 of the 4 tests.
- `packages/sync/src/infra/powersync/sync-rules-engine.integration.test.ts`: 7 pass with
  `POWERSYNC_ENGINE_EXEC="wsl -e docker exec -i rpg-powersync"`. The service's own sync-rules
  engine evaluates the PowerSync dialect of 5 fixture classes over the exhaustive truth table
  (observer included) with no divergence from `decide`; this covers `auth.user_id() IN <json
  column>` and mixed membership/row `OR`. `sync-config.yaml` compiles with no diagnostics.
- Not live: observer memberships (feature 01 role CHECK) and reveal of a content row (no
  registered class with per-row Visibility yet) are covered by the engine and shadow-table
  checks only. Delivery into browser SQLite through the web SDK is not exercised.

## Open

- Closed 2026-10-26: PowerSync accepts the generated syntax (after the dialect fixes above),
  removes rows on un-reveal and revocation, and emits no operation for a never-matched tombstone.
- Hold authority checks the record (2026-10-26, see task 06 "Record access"). Closed 2026-10-28
  by feature 16 task 04 (B-3), without a join: the holds query admits `campaign` holds as before,
  `campaign_entity` holds for `owner`/`gm`/`assistant_gm` (the roles that read every entity), and
  `personal_note` holds for the holder only; derived from the declarations and drift-gated, live
  provider check in `sync-config.powersync.integration.test.ts`.
- Authority tombstone sequences must not be a dense per-scope counter replicated to players, or
  gaps would count hidden tombstones. The purge rule's eligible subscribers include replicas that
  never saw a hidden tombstone; this retains the tombstone longer but leaks nothing.
- Closed 2026-10-26 (task 08): browser SQLite. The web SDK writes membership tombstones and
  campaign rows into browser SQLite. `BrowserSyncSession` calls
  `ReplicaAccessReconciler.applyMemberships` after each consistent checkpoint, and `accessDenied`
  on a bootstrap 404. `apps/web/e2e/live-sync.e2e.ts` (live service) covers:
  - revocation while connected: campaign rows, settings and queue are removed, and the cached
    membership is tombstoned;
  - revocation while offline: on reconnect, bootstrap returns 404 and the replica is cleared;
  - a revoked member's queued write is not applied;
  - sign-out clears everything.
  Disabling the reconciler call fails the revocation test.
- Authority sequences per scope do not exist yet; tombstone owners must supply `TombstoneRef`
  sequences before purge reports cover real rows. Issued 5-minute provider tokens are not
  revoked; the stream's active-membership join stops serving the campaign.
