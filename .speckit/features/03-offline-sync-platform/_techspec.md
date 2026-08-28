# TechSpec: Offline-First Sync Platform

Source: `_prd.md`, `_bdd.md`, `_domain.md`, `_db.md`, feature 00 spike/freeze/ADR, and current
`SyncedRepository` contracts.

## Current Facts

- The wave 0 spike proved PowerSync/SQLite-WASM/OPFS viability and deferred-conflict timing.
- `SyncedRepository` and `ConflictChannel` are frozen; the repository currently provides only an
  in-memory test implementation.
- sqlite-wasm must run in a worker from copied static assets, and the PWA must be cross-origin
  isolated. IndexedDB fallback, real permission rules, multi-client convergence, and revocation
  were not proven by the spike.
- No PowerSync package/service integration or browser persistence exists in the application.

## Proposed Architecture

Add `packages/sync` with:

- provider-neutral `SyncEngine`, `ReplicaManager`, `MutationQueue`, `ConflictStore`, `HoldService`,
  `SyncStatusStore`, and `RevocationConsumer`;
- `SyncedRepository` implementation over worker RPC;
- PowerSync read adapter and application-owned Fastify upload endpoint;
- PostgreSQL mutation appliers registered by feature, never generic table SQL from clients;
- OPFS primary and IndexedDB-backed VFS fallback selected by capability detection in the worker.

React adds one shared sync-status/conflict surface and hold/takeover primitives. Consuming features
use repository/contracts only and never import provider APIs.

## Worker and Build

Copy the pinned sqlite-wasm `jswasm/` distribution unchanged to a versioned static asset path and
start its classic worker from a dedicated application worker. All database operations cross typed
message RPC. Vite must not bundle/rewrite the sqlite sibling-worker URLs.

Serve app and attachment subresources with COOP `same-origin` and COEP `require-corp`; add automated
header tests. Service-worker caching includes static sqlite assets but never caches signed URLs.

## Server Interfaces

| Interface | Purpose |
| --- | --- |
| `POST /sync/mutations` | authenticated ordered mutation batch; per-item accepted/conflict/error outcome |
| `GET /sync/bootstrap/:campaignId` | provider/session bootstrap after current access decision |
| `POST /sync/replicas/:campaignId/ack` | cursor/tombstone watermark acknowledgment |
| `DELETE /sync/replicas/:campaignId` | local cleanup acknowledgement after revocation |
| Hold acquire/renew/takeover/release endpoints | authority-arbitrated single-writer long text |

Upload schemas accept registered operation shapes, never arbitrary table/column names. Every item
re-resolves Actor, resource class, feature 04 authorization, expected version, and mutation ID.
Batch outcome preserves causal order within a campaign.

## Mutation Flow

1. Feature validates and writes locally through `SyncedRepository`.
2. Worker atomically records domain row, pending mutation, and audit envelope.
3. UI observes immediate local value and pending count.
4. On connection, ordered batches upload with stable mutation IDs.
5. Authority applies each registered mutation transactionally and returns accepted version or
   typed conflict/error.
6. Acceptance compacts payload after durable cursor; rejection creates durable conflict and emits
   `ConflictChannel` without silently replacing the local value.

Conflict UI supports defer, keep authority, resubmit mine against the current version, and
renderer-supported manual merge. Resolution itself is a new versioned mutation.

## Authorization and Visibility

Feature 04 declarations generate API and sync predicates. Bootstrap and upload both require current
membership. Membership removal triggers subscription revocation and replica deletion; server writes
deny immediately even if the device is offline. A contract-change note adds a provider-neutral
`CampaignAccessRevoked`/replica-purge boundary because the frozen contracts currently lack one.

## Data, Retention, and Offline

Implement `_db.md`: bookkeeping tables, 10 MB hard allocation, watermark purge, 120-second renewable
holds, and no eviction of confirmed pending mutations. At capacity, refuse new offline writes with
a clear state while preserving reads and existing work.

Startup opens the worker/local schema before React requests campaign data. A warm offline typical
campaign must reach usable Session Mode under 2 seconds p95 on the documented browser/device matrix.
Initial synchronization exposes progress and marks a replica available only after one consistent
authorized cursor.

No general realtime/WebSocket layer is added. Provider change delivery is synchronization, not
ephemeral presence. Attachment bytes remain feature 05.

## Failure Handling and Observability

- Transport failure retains queued work and reports offline/error with pending count.
- Storage migration failure reopens prior schema or drops/re-downloads only after confirming no
  unaccepted local mutation exists.
- Provider/bootstrap/auth failures fail closed and never expose bucket details.
- Metrics: queue age/count/bytes, upload outcomes, conflicts, replica bootstrap, purge backlog,
  local-open duration. No payload/user-content labels.
- Logs use campaign/mutation IDs and safe error codes only.

## Testing

- Unit: state machines, retry/backoff, ordering, idempotency, semantic operations, holds, capacity.
- Browser integration: OPFS primary, forced fallback, restart durability, worker asset loading,
  COOP/COEP, service-worker upgrade.
- PostgreSQL/provider: offline round trip, multi-client convergence, deferred conflict, tombstone
  watermark, membership revocation, visibility absence.
- Contract: every feature mutation applier and `SyncedRepository` conformance.
- Playwright/performance: promised offline flows and p95 cold open on reference matrix.
- Failure injection: lost acknowledgment, duplicate batch, provider outage, disk full, corrupt local
  migration, revoked user upload.

## Impacted Areas

- `packages/sync/` — new engine, worker, adapters, schemas, tests.
- `apps/api/src/modules/sync/` — bootstrap/upload/hold composition.
- `apps/web/src/features/sync/` and Vite/public assets — status/conflict UI and worker assets.
- `compose.yaml` — persistent PowerSync services/configuration and least-privilege credentials.
- Feature 00 contract-change note and contracts — revocation boundary only.
- Feature 04 — generated sync-rule adapter.

## Blockers

- Ratify the post-freeze revocation/purge boundary with one reviewer per track.
- Document the supported browser/device performance matrix before accepting the p95 gate.
- Prove the forced IndexedDB fallback before enabling production offline claims.

