# Task 04: PowerSync read path and authorized upload endpoint

Status: implemented; provider round trip verified at the sync-protocol level and in browser SQLite
through the PowerSync web SDK (2026-10-26). Upload authorization, per-item outcomes, and the
least-privilege publication are done and tested against PostgreSQL. Authority changes reach a
protocol-level replica (see "Provider round trip") and browser SQLite (see "Browser delivery").

## Scope

- Add persistent sync-service configuration to the local stack and package adapter.
- Implement bootstrap and ordered mutation-batch Fastify routes with TypeBox.
- Register feature mutation appliers; reject arbitrary table/column operations.
- Test initial/incremental sync, reconnect, idempotency, and current-membership authorization.

## Acceptance Criteria

- Connected authority changes reach local SQLite without manual refresh.
- Offline queue drains in causal order and reports per-item outcomes.
- Revoked/unauthorized uploads fail closed regardless of cached role.

## Verification

```bash
bun test packages/sync apps/api/src/modules/sync
bun run typecheck
```

## Progress (2026-10-24)

- Creation-scoped upload authorization (`packages/sync/src/authority.ts`, `model.ts`): every item
  re-resolves current membership. With none, only `isCampaignCreation` (insert,
  `recordId === campaignId`, `expectedVersion === null`) may proceed, through the single
  registered `MutationApplier.applyCreation({ creatorUserId, mutation })`; the creator must then
  resolve as a member or the item is `not_found_or_forbidden`. A creation `conflict` is masked as
  denial. Later items resolve membership normally. `CampaignSyncMutationApplier.applyCreation`
  requires `payload.createdBy === creatorUserId` and hides `campaign_conflict`/`owner_conflict`.
- Retryable authority errors are no longer persisted as receipts (they replayed forever).
- Per-item outcomes: `MutationQueue.drainWithOutcomes()` returns `MutationDrainReport`
  (`state`, causal-order `outcomes: DrainedMutationOutcome[]` with routing identity and
  `result: accepted | conflict | rejected | retry`, `conflicts`). `drain()` is unchanged.
- Upload route: TypeBox rejects extra fields (column lists, SQL), bad table names, unknown
  operations, and empty batches with 400; unordered batches and cross-campaign items get
  per-item errors; replay returns identical outcomes; session and same-origin required.
- Migration `packages/identity/drizzle/0003_least_privilege_sync_publication.sql` replaces the
  `FOR ALL TABLES` `powersync` publication with `campaigns`, `campaign_settings`,
  `identity_campaign_memberships`, `sync_long_text_holds`.
  `packages/sync/src/infra/postgres/publication.integration.test.ts` asserts sync config ==
  publication (via `pg_publication_tables`), excludes every credential/session/recovery/
  invitation/binding/user/bookkeeping table, and decodes a temporary `pgoutput` slot to prove
  campaign and membership changes stream while credential/session rows never do.
- Evidence: `bun test packages/sync` 40 pass; `bun test apps/api/src/modules/sync` 22 pass;
  `bun test packages/contracts packages/sync apps/api --timeout 30000` 173 pass; typecheck exit 0;
  guard no violations; `bun run test:e2e` 18 pass (first cold run failed 2 offline-sync tests
  with a Vite reload "execution context destroyed"; rerun passed).

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

## Browser delivery (2026-10-26)

Feature 03 task 08 wired `@powersync/web` 1.39.1 into the browser session
(`BrowserSyncSession`, `@rpg/sync/browser`):

- The connector bootstraps with any campaign that still authorizes the user.
- Uploads send the registered `POST /sync/mutations` batch from the local queue.
- The old connector gated uploads on `getCrudBatch()`, but the queue tables are local-only, so no
  upload-queue entry ever existed and the queue never drained. Local writes now also write the
  replica row, which gives the provider its upload-queue entry.

Evidence: `apps/web/e2e/live-sync.e2e.ts`, live service, 7 pass, 21/21 with `--repeat-each=3`.

- A player's browser SQLite holds exactly the permitted campaign, member-visible setting, and own
  membership.
- A second browser context receives an authority change without refresh.
- After reconnect, offline writes drain in causal order and converge.

Details: task 08 and `docs/OFFLINE_SYNC_RUNTIME.md`, "Browser replica through the web SDK".

## Open

- [x] Connected authority changes reach local SQLite (2026-10-26). The web SDK writes initial and
  incremental changes into browser SQLite, OPFS and IndexedDB, with no manual refresh (see
  "Browser delivery").
- [x] Stale inactive slot `powersync_1_2df1` dropped 2026-10-26; the service rotates its own slot
  on a sync-config change (`powersync_1_*` → `powersync_2_*`, old slot cleaned up).
- [x] Dedicated least-privilege replication user (2026-10-26): migration
  `0006_powersync_replication_role` (`powersync_replicator`: LOGIN REPLICATION, SELECT on the four
  published tables only, no password in the migration); `compose.yaml` sets the dev password
  through the `powersync-replication-role` one-shot and points `PS_DATA_SOURCE_URI` at the role.
  PowerSync stays healthy and replicates (live test 4/4). Role confinement:
  `packages/sync/src/infra/postgres/replication-role.integration.test.ts` (4 tests). A fresh
  initial snapshot under the role was not forced (the slot resumed).
- [x] `drainWithOutcomes`/`authorityAccepted` wiring: `CampaignReplicaSync.afterDrain` (feature 02 task 06). No browser composition calls it yet.
