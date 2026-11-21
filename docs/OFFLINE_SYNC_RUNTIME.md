# Offline Sync Runtime

Verified 2026-08-31 on Windows 11 Pro build 26200, Microsoft Edge 152.0.4191.53
(headless), AMD Ryzen 7 3700X, and 31.9 GB RAM.

## Browser requirements

- JavaScript, WebAssembly, Web Workers, and persistent browser storage.
- `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp` for the OPFS worker path.
- IndexedDB is the fallback when OPFS is unavailable.
- Pinned PowerSync 1.39.1 and WA-SQLite 1.7.0 worker/WASM assets are copied by
  `bun run --cwd apps/web sync:assets` before development and production builds.

## Measured local database open

The Playwright acceptance opens a persisted fixture, closes it, and measures 20 cold database
reopens for each backend. The p95 results from the verified matrix were:

| Backend | p95 |
| --- | ---: |
| OPFS | 198.4 ms |
| IndexedDB | 79.9 ms |

Run with:

```bash
bun run test:e2e -- apps/web/e2e/offline-sync.e2e.ts
```

This proves browser-worker asset loading, persistence across database restart, and the local
database portion of the two-second startup budget. It does not yet prove installed-PWA Session
Mode time-to-usable or the complete promised offline-flow matrix; those gates require the
dependent feature screens and fixtures.

## Local service stack

The repository defines PostgreSQL 17 with logical replication, MongoDB 7, and PowerSync Service
1.25.0 in `compose.yaml`. Verified 2026-10-26 with Docker in WSL on Windows 11 Pro build 26300:
`docker compose up -d mongo powersync` starts both, PowerSync replicates the four published
tables, and its diagnostics (`POST /api/admin/v1/diagnostics` with the admin token) report no
connection, table, or sync-config errors.

- MongoDB runs as the single-member replica set `rs0`. PowerSync's bucket storage uses
  transactions, and a standalone `mongod` fails with "Transaction numbers are only allowed on a
  replica set member". The `mongo` healthcheck initiates the replica set on first start.
- A container that ran an older `powersync` service definition is recreated by `up`.
- If PostgreSQL was created from an older compose definition, use
  `docker compose up -d --no-deps mongo powersync` so `up` does not recreate `postgres`.
- PowerSync connects as the dedicated role `powersync_replicator`, never the database owner
  (see "Replication role"). Start the one-shot that sets its password together with the service:
  `docker compose up -d --no-deps powersync-replication-role mongo powersync` (plain
  `docker compose up -d mongo powersync` does it through `depends_on`).
- Multi-client convergence through the web client is verified by `apps/web/e2e/live-sync.e2e.ts`
  (see "Browser replica through the web SDK").

## Sync publication

`bun run db:migrate` applies `0003_least_privilege_sync_publication`, which replaces the
`powersync` publication with exactly the tables `infra/powersync/sync-config.yaml` streams:
`campaigns`, `campaign_settings`, `identity_campaign_memberships`, `sync_long_text_holds`, plus the
audit stores (0007) and, since feature 16 task 02 (`0011_content_entities`), `content_entities` and
`content_personal_notes`, and since task 08 (`0012_content_relationships`),
`content_entity_relationships`. Credential, session, recovery, invitation, binding, user, and sync bookkeeping tables are never
published. The `current_user_memberships` stream sends each user only their own membership rows
(including removal tombstones) with the feature 01 cache fields. A newly streamed table needs a forward migration
(`ALTER PUBLICATION powersync ADD TABLE ...`); `packages/sync/src/infra/postgres/publication.integration.test.ts`
fails until the publication and the sync config agree.

## Replication role

`bun run db:migrate` applies `0006_powersync_replication_role`: the role `powersync_replicator`
has `LOGIN REPLICATION`, is not superuser and cannot create databases or roles, and holds
`SELECT` on exactly the four published tables. It cannot write, create objects, or read any
other table (users, sessions, credentials, recovery tokens, invitations, audit stores, receipts)
or the `drizzle` schema. The migration stores no password.

- Local: the `powersync-replication-role` one-shot in `compose.yaml` runs
  `ALTER ROLE ... PASSWORD` from `POWERSYNC_REPLICATION_PASSWORD` (dev default in `.env.example`).
  `PS_DATA_SOURCE_URI` is built from the same variable; URL-encode a password with reserved
  characters.
- Deploy: run the migration with a role that may create roles, then set the password once from the
  deploy secret store (`ALTER ROLE powersync_replicator PASSWORD '<secret>'`) and give PowerSync a
  matching `PS_DATA_SOURCE_URI`. Never reuse the application or owner password.
- A table added to the publication needs, in the same forward migration,
  `GRANT SELECT ... TO powersync_replicator`. `replication-role.integration.test.ts` fails if
  the grants and the publication diverge, or if the role can write or read anything else.
- Verified 2026-10-26: PowerSync recreated with this role resumed slot `powersync_5_0404`
  (`pg_stat_activity.usename = powersync_replicator`), stayed healthy, and the live round-trip
  test passes. A fresh initial snapshot under the role was not forced.

A provider replication slot created before this migration may fail to decode across the
publication replacement. Locally, stop PowerSync and drop its inactive slot before restarting it:

```bash
docker compose stop powersync
docker compose exec postgres psql -U rpg -d rpg -c \
  "select pg_drop_replication_slot(slot_name) from pg_replication_slots where slot_name like 'powersync_%' and not active"
docker compose up -d mongo powersync
```

Changing `sync-config.yaml` and restarting PowerSync creates a new sync-config version and a new
slot, replicates from a fresh snapshot, activates it, and then drops the old slot by itself
(observed: `powersync_1_*` → `powersync_2_*`). An inactive slot left by an earlier provider
installation is not cleaned up and retains WAL; drop it with the command above (done on
2026-10-26 for the spike's `powersync_1_2df1`).

## Sync rules from Resource Policies

Feature 04 compiles each registered Resource Policy into a provider-neutral predicate AST
(`SyncPredicateCompiler.compile(...).rule`, `@rpg/authorization`). `compileProviderQueries`
(`@rpg/sync`) translates it into row-filter queries. Each query takes the class's approved
projection, inner-joins the requester's current membership in the row's campaign (not removed,
with a reading role), and applies the Visibility, target, and ownership filters. Tombstones are
not filtered out: they follow the same predicate as live rows, so a replica that could not read a
row never receives its tombstone.

The registered classes and their stream bindings live in `apps/api/src/modules/sync/sync-rules.ts`.
Today that is `campaign` (stream `authorized_campaigns`) and, since feature 16 task 04,
`campaign_entity`, `personal_note`, and (task 08) `entity_relationship` (stream
`authorized_content`; their projections are
`CONTENT_REPLICA_TABLES` in `@rpg/content`, which the web app also passes to the browser schema
through `BrowserSyncSession.open({ tables })`). Each content query is a per-row predicate on its own
table plus the requester's membership row; no content query joins another content table
(PowerSync 1.25.0 does not enforce joined-row equality). A relationship is therefore filtered by
its own Visibility only; the bound by its endpoints is a write-time invariant (feature 16 D-07
option A: relationship writes refuse a wider value, an endpoint narrowing narrows its links in the
same transaction). For those classes, the stream queries in `sync-config.yaml` are
compiled output and must not be edited by hand.
`apps/api/src/modules/sync/sync-config.integration.test.ts` fails when:

Feature 09 adds recorded rolls in their own stream, `authorized_rolls`, projected from
`DICE_REPLICA_TABLES`. GM-only and blind rolls are outside that stream's predicate for a player, so they are
absent from a player's replica. Rolls are insert-only, and they queue no audit envelope
(`repository({ audited: false })`).

Feature 11 adds effect applications in `authorized_effects`, projected from `ACTIONS_REPLICA_TABLES`. A device
applies a plan by writing one row and one queue entry, so it is whole on the device. A target's displayed state is the
owner's replica plus records with no `accepted_at`; the accepted row and the owner's new state arrive in one checkpoint.

After a change to `sync-config.yaml` and a service restart, the old rules keep serving until the new ones
finish reprocessing, about 15 to 30 seconds on the local stack. A test run inside that window exercises the
old rules.

- a class's query drifts from the compiled output;
- a class's query sits in the wrong stream;
- a content table is streamed by a hand-written query.

Only the platform tables `campaign_settings`, `sync_long_text_holds`, and the membership stream
are exempt from that last check. To update the configuration after a declaration changes, render
the expected query with `compileProviderQueries` and paste it in.

The platform queries are still checked:

- Both carry the campaign class's reading-role scope.
- A setting that is not member-visible is GM-only.
- A hold names its record, so (feature 16 task 04, B-3) the holds of a class reach a role only if
  that role reads every row of the class whatever its Visibility and the class has no Ownership
  Rule (`campaign`: every reader; `campaign_entity` and `entity_relationship`: `owner`, `gm`,
  `assistant_gm`); a class
  with an Ownership Rule (`personal_note`) sends its holds to the holder only
  (`holder_user_id = auth.user_id()`). A class with no branch (server-only, or not updatable)
  replicates no hold.

The same test derives these filters from the declarations. It also runs every configured query
on rolled-back shadow copies of the real tables, observers included, and compares the result with
`AuthorizationService.decide`.

The same renderer has a PostgreSQL dialect. `packages/sync/src/infra/postgres/sync-rules.integration.test.ts`
runs that dialect on test-scoped tables and compares it with the pure decision across the
exhaustive truth table: roles × modes × targets × authors × tombstones × campaigns, plus removed
members and non-members. It also simulates replica deltas for reveal, un-reveal, unseen
tombstones, and hidden-row counts.

### PowerSync 1.25.0 dialect

Verified against the running service and its sync-rules engine on 2026-10-26. The configuration
written before that was rejected (`Fatal replication error`, the service restarted in a loop):

- Literal tuple lists `IN ('a', 'b')` are rejected ("This expression is not supported by
  PowerSync"). A value set renders as a JSON array literal, `m.role IN '["owner","gm"]'`. `OR`
  chains also work, but every `OR` expands into the disjunctive normal form, which is limited to
  100 terms per query; a JSON array is one term.
- `concat(...)` is an unknown function; ids are built with `||`.
- A source-table alias renames the synced table (`FROM campaigns c` syncs rows as table `c`;
  clients read `campaigns`). Source tables are unaliased and columns are qualified with the table
  name. Only the joined membership relation keeps the alias `m`.
- `auth.user_id() IN <json column>` and `OR` branches that mix membership and row conditions are
  accepted and evaluate exactly as `decide` does (engine check below).

The PostgreSQL dialect renders value sets as `IN ('a', 'b')`. The simulated-replica test runs the
configured PowerSync queries on PostgreSQL after rewriting `auth.user_id()` to `$1` and JSON array
value sets to tuple lists.

### Provider checks

- `apps/api/src/modules/sync/sync-config.powersync.integration.test.ts` (runs when PostgreSQL and
  the PowerSync service are reachable; `POWERSYNC_ENDPOINT`, `POWERSYNC_JWT_SECRET` default to the
  development values). It commits fixture rows, mints HS256 tokens like the API, and applies the
  real `/sync/stream` protocol to a small replica model, with `/write-checkpoint2.json` as the
  barrier so absence is real. It covers:
  - owner, gm, assistant_gm, player, removed gm, non-member, and other-campaign owner receive
    exactly the campaigns, settings, holds, and own memberships that `decide` allows, tombstones
    included; a hold on a non-campaign-wide class reaches nobody;
  - promotion adds GM-only settings, demotion removes them, revocation removes every campaign row
    and delivers the membership tombstone;
  - creating and deleting hidden settings leaves a player's ops, bucket counts, and checksums
    unchanged; a setting that stops being member-visible arrives as a REMOVE; a seen setting that
    is deleted arrives as a tombstone;
  - a token signed with another key is rejected with 401.
- `packages/sync/src/infra/powersync/sync-rules-engine.integration.test.ts` (opt-in:
  `POWERSYNC_ENGINE_EXEC="docker exec -i rpg-powersync"`, or `wsl -e docker exec -i rpg-powersync`
  with Docker in WSL). It runs `infra/powersync/engine-check.mjs` inside the service container,
  so the service's own sync-rules engine evaluates the PowerSync dialect of five fixture classes
  (targeted, ownership with exempt roles, GM-secret, campaign-wide, author-private) over the
  exhaustive truth table, observers included, and finds no divergence from `decide`. It also
  checks that `sync-config.yaml` compiles with no errors or warnings, and that dropping the
  target filter is detected.

Observer memberships cannot be stored in the real tables (feature 01 role CHECK), so the live
round trip covers observers only through the shadow-table and engine checks. Since feature 16
tasks 04 and 08 the live round trip also covers content rows: per-row reveal (PUT) and un-reveal
(REMOVE) of an entity, and a relationship narrowed after its endpoint is hidden (REMOVE), with a
link to a hidden endpoint never reaching a player.

## Browser replica through the web SDK

Verified 2026-10-26 (feature 03 task 08) on Windows 11 Pro build 26300, AMD Ryzen 7 3700X,
31.9 GB RAM, against the compose PowerSync Service 1.25.0 with `@powersync/web` 1.39.1
(`@powersync/common` 1.57.3, Rust sync client, HTTP streaming).

- `BrowserSyncSession` (`@rpg/sync/browser`) opens one replica per signed-in user
  (`rpg-replica-<userId>.sqlite`) before any network request, so a synchronized replica is
  readable offline. The streams are per user (`auth.user_id()`), so one replica holds every
  authorized campaign.
- Credentials: `GET /sync/bootstrap/:campaignId` authorizes one campaign. The connector tries the
  cached active memberships and the campaign named by the app, in order. A `404` purges that
  campaign's local state through `ReplicaAccessReconciler.accessDenied`. When every candidate is
  denied, nothing can deliver a provider-side removal any more, so the session calls
  `disconnectAndClear({ clearLocal: false })` and reports `no_campaign_access`. Local-only rows
  (queue, conflicts, membership tombstones) survive that clear.
- Memberships: after each consistent checkpoint (`hasSynced`), the replicated
  `identity_campaign_memberships` rows go to `ReplicaAccessReconciler.applyMemberships` as the
  complete current-user set. The reconciled cache lives in the local-only `sync_membership_cache`.
  A tombstone or absence purges the campaign's local-only state. The provider itself removes the
  campaign's replicated rows, because every stream joins the active membership.
- Local writes: `BrowserReplicaStore.record` writes the replica row and the queued mutation in one
  SQLite transaction. The row write gives PowerSync an upload-queue entry. `uploadData` then sends
  the registered `POST /sync/mutations` batch from `sync_pending_mutations`, never the raw row
  diff. It completes PowerSync's queue only when no queued mutation remains. A transport failure
  or a retryable outcome throws, so PowerSync retries with the same mutation ids. PowerSync applies
  no downloaded checkpoint while its upload queue is non-empty.
- Status: `SyncStatusStore` precedence is error (including unresolved conflicts and rejected
  mutations) > offline (`navigator.onLine` false) > pending > synchronizing (no consistent
  checkpoint yet; shows download progress) > synchronized. "Synchronized" therefore needs a
  connection, an empty queue, no conflict or error, and a completed initial sync. The dashboard
  shows it through `useBrowserSync`; logging out calls `signOut`, which purges every campaign and
  clears the replica.
- Build: the web client references its own worker modules, so `vite.config.ts` sets
  `worker.format: 'es'`. The app still runs the pinned copied workers under `/sync-assets/`.

### Live browser acceptance

```bash
bun run test:e2e -- apps/web/e2e/live-sync.e2e.ts
```

The spec needs `DATABASE_URL` (or `TEST_DATABASE_URL`) and a reachable PowerSync service
(`POWERSYNC_ENDPOINT`, default `http://localhost:8080`). Without them its tests are skipped.

The provider, replication, and browser storage are real. `/sync/bootstrap` and `/sync/mutations`
are replaced at the network edge by a stand-in with the API's wire contract:

- bootstrap mints the API's HS256 token only for a current membership;
- mutations apply the campaign-details update with a version check and receipt idempotency.

Fixture SQL lives in `apps/web/e2e/fixtures/live-sync.sql`.

Covered:

- **Visibility and revocation.** A player's browser SQLite holds exactly the permitted campaign,
  the member-visible setting, and the player's own membership. The owner also receives the
  GM-only setting. Revocation while connected empties the player's campaign rows, settings, and
  queue, and tombstones the cached membership.
- **Revoked while offline.** The membership is revoked while the app is closed. On reconnect,
  bootstrap returns 404 and the replica is cleared.
- **Revoked with queued writes.** A revoked member's queued write is refused by the authority and
  removed from the device.
- **Status.** Initial sync reports progress. "Synchronized" is never shown before a consistent
  checkpoint or while work is queued.
- **Offline edits.** Two offline edits survive a session restart, then drain in causal order. A
  second browser context converges through the provider.
- **Failure injection.**
  - An upload failure (HTTP 500) shows an error and keeps the pending count.
  - After a lost acknowledgement, the retry reuses the mutation id and the edit applies once.
  - A retryable outcome stays pending.
  - A deferred conflict keeps the submitted value and is reported as unresolved.
- **Sign-out and dashboard.** Sign-out, and the dashboard's logout, clear the replica.

A 200-setting campaign was synchronized, then the replica was reopened 20 times. Each sample runs
from creating the database to the first campaign and settings reads. Worker script loading and the
app shell are excluded.

| Browser | Backend | p95 | median |
| --- | --- | ---: | ---: |
| Edge 156.0.4314.42 (headless) | OPFS | 126.5 ms | 121.0 ms |
| Edge 156.0.4314.42 (headless) | IndexedDB | 44.3 ms | 38.6 ms |
| Chromium headless shell 151.0.7922.34 | OPFS | 127.9 ms | 117.8 ms |
| Chromium headless shell 151.0.7922.34 | IndexedDB | 45.8 ms | 37.0 ms |

Not verified here:

- An installed PWA restarting offline through its service worker on Firefox or WebKit: Playwright refuses those
  navigations. It is verified on Chromium engines by `apps/web/e2e/pwa.e2e.ts`.
- Session Mode time-to-usable. No Session Mode screen exists yet.
- Safari itself and real mobile devices. `bun run test:e2e:matrix` runs the suite on Firefox and WebKit on Linux and
  on phone emulation; see feature 03 task 08 for results and limits.
- The promised offline flows that have no feature yet: sheets, notes, dice, rules, encounters,
  resources. Only the campaign-details edit is exercised.
- The production build also bundles the SDK's own worker and WASM chunks, which the app does not
  load. Their precache entries are not pruned.

## Audit stores (feature 06 task 04)

Verified 2026-10-27 against the compose PowerSync Service 1.25.0 (fresh snapshot under
`powersync_replicator` after the config change, slot `powersync_6_*`).

- Migration `0007_audit_sync_publication` adds `audit_campaign_events` and `audit_private_events`
  to the `powersync` publication and grants the replication role `SELECT` on them. The account
  store, sequence allocators, and repair outbox are never published.
- Streams `campaign_audit` and `gm_private_audit` (one per physical store) are compiled by
  `compileAuditProviderQueries` (`@rpg/sync`) from the registered Resource Policies and
  `AUDIT_SYNC_STORES` (`apps/api/src/modules/sync/sync-rules.ts`); do not edit them by hand.
  `apps/api/src/modules/sync/audit-sync.integration.test.ts` is the drift gate, runs the
  PostgreSQL rendering on shadow tables against `AuditTargetAccess` (the task 03 read decision),
  and, with `POWERSYNC_ENGINE_EXEC`, runs the service's own engine on the same fixture.
- An event replicates only when the target's current row and class rule, the stored snapshot, and
  (private store) the GM reading roles all allow it. Only classes whose records are the campaign
  itself (`campaignColumn = id`) can be proven: PowerSync resolves each joined relation as an
  independent parameter lookup, so an equality between a joined row and the audit row is not
  enforced, and an unkeyed target join makes every live record a parameter (the service fails
  with "Too many parameter query results (limit of 1000)"). The target join is keyed by the
  subscribed campaign. Server-only, Ownership-Rule, party-targeted, and per-record classes stay
  online-only (task 03 API); today only `campaign` events replicate, membership events never.
- Projection: no `campaign_sequence` (gaps would count hidden events), no snapshot, no origin
  mutation. Local order is acceptance time, then id.
- Neither stream is subscribed by default. A device subscribes per `(campaign_id, month)` window
  (`AuditWindowManager`), and to `gm_private_audit` only while its cached role is a GM role; the
  `audit_private_events` table exists in the replica schema only then (`replicaSchema`), so a
  player replica has no private table, view, untyped row, or stream subscription
  (`live-sync.e2e.ts`). A forged private subscription still yields nothing (the query decides).
- Compaction (`planAuditWindow`): the newest 90 days stay; older months stay newest first while
  both stores together are within 10 MB (estimated as column bytes x 2 for PowerSync's data and
  operation-log copies); the first month that does not fit is evicted with all older ones by
  forgetting its subscriptions, so the provider removes the rows. Pending events live in the
  mutation queue and are never evicted; no row moves between stores. The window and the
  partial-history marker are kept in the local-only `sync_audit_window`. Eviction granularity is a
  month.
- Retention acknowledgement (2026-10-28): after a consistent checkpoint, and whenever the set of
  synced audit subscriptions changes, `BrowserSyncSession` asks
  `AuditWindowManager.acknowledgements()`. Per store, only when every window month is subscribed on
  this device and its stream status reports `hasSynced`, it posts
  `POST /sync/replicas/:campaignId/ack` with `{ replicaId, tableName, throughEventId }`, naming the
  newest accepted event it holds (a player never names the private store). The API resolves the ID
  to `campaign_sequence` only if the user may read that event now and stores it in
  `sync_replica_watermarks`; nothing is returned (`204` in every case). Only a changed claim is
  sent, and failures retry on the next checkpoint without touching synchronization.
- Server deletion (365 days) is off unless `AUDIT_RETENTION_DELETE=true`; see feature 06 `_db.md`
  "Server Retention". The report: `bun run apps/api/src/modules/audit/retention-cli.ts`.

## Attachments (feature 05 tasks 05–07)

Verified 2026-10-27 against the compose stack (PostgreSQL, MinIO, PowerSync Service 1.25.0) in
Edge headless.

- Attachment metadata is not replicated. Its read rule needs the owning record's decision (a join
  to a per-record owner table), which PowerSync 1.25.0 cannot enforce (see "Audit stores"). The
  `attachments` table is in no publication and `powersync_replicator` cannot read it
  (`packages/attachments/src/infra/postgres/retention.integration.test.ts`).
- Each signed-in user has an offline attachment store beside the replica: IndexedDB
  `rpg-attachments-<userId>` (records and bytes, written together). `useBrowserSync` passes it to
  `BrowserSyncSession` as a `ReplicaPurgeListener`, so a revocation, campaign deletion or sign-out
  purge removes that campaign's attachment metadata and bytes and aborts its downloads. On each
  observed synchronization (at most every 30 s) the store reconciles against the authorized
  offline set: attachments no longer listed are removed; a 404 purges the campaign; offline,
  nothing changes (a disconnected device keeps its copy until it reconnects).
- Campaign pinning downloads nothing until the user confirms the size estimate; each byte comes
  from a fresh five-minute read grant and is verified (size, SHA-256) before it is stored.
- Live evidence: `apps/web/e2e/live-sync.e2e.ts` ("revocation through the provider removes pinned
  attachment bytes ...", and the dashboard logout test), `apps/web/e2e/attachments-offline.e2e.ts`
  (restart with the network down, estimate accuracy, narrowing, revocation).
