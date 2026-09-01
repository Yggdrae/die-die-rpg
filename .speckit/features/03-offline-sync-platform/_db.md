# Data Design: Offline-First Sync Platform

Source: `_prd.md`, `_bdd.md`, `_domain.md`, feature 00 freeze decisions/spike findings, and the
frozen repository contracts.

## Storage Responsibilities

PostgreSQL remains each feature's authoritative relational store. Feature 03 owns the browser
replica, durable upload queue, conflict records, long-text holds, synchronization cursors, and
tombstone acknowledgment needed to move data safely. It does not own another feature's domain row.

Preferred local persistence is SQLite/WASM in an OPFS worker. The fallback is an IndexedDB-backed
SQLite VFS. PowerSync is the initial transport implementation behind the provider-neutral boundary.

## Local SQLite Schema

Provider-managed replicated tables mirror only approved columns from owning features. Application-
owned bookkeeping uses the following logical tables.

### `sync_campaign_state`

| Column | Meaning |
| --- | --- |
| `campaign_id text` | primary key |
| `replica_state text` | `populating`, `available`, `dropping`, `error` |
| `last_server_cursor text` | opaque provider cursor |
| `last_sync_at text` | nullable authority-confirmed instant |
| `last_error_code text` | nullable safe code |

### `sync_pending_mutations`

| Column | Meaning |
| --- | --- |
| `mutation_id text` | UUID primary key and idempotency key |
| `campaign_id text` | indexed scope |
| `feature_id text`, `table_name text`, `record_id text` | routing only |
| `operation text` | insert, update, tombstone, or semantic operation |
| `expected_version integer` | nullable only for create |
| `payload text` | validated canonical JSON; may contain user content |
| `causal_sequence integer` | monotonically increasing per campaign/device |
| `state text` | pending, uploading, accepted, conflicted, rejected |
| `attempt_count integer`, `next_attempt_at text` | bounded retry state |
| `recorded_at text`, `terminal_at text` | lifecycle timestamps |

Unique `(campaign_id, causal_sequence)` and stable `mutation_id` make queue drain ordered and
idempotent. Payload is deleted only after authoritative acceptance is durably acknowledged, or
after explicit conflict resolution produces a replacement/abandon decision.

### `sync_conflicts`

Stores durable deferred conflicts: conflict ID, mutation ID, campaign/record identity, expected and
actual versions, submitted canonical value, current authoritative value, detection time, resolution
state, resolver, and resolution time. Conflicts remain until resolved and synchronized; dismissal
defers attention but does not resolve or delete the mutation.

### `sync_tombstone_watermarks`

Stores campaign/table scope, authority tombstone sequence, device subscriber identity, and last
acknowledged sequence. The server may purge a domain tombstone only when:

1. it is at least 90 days old;
2. every membership/device subscription eligible before deletion has either acknowledged a cursor
   beyond it or been revoked and had its replica marked for destruction; and
3. no pending mutation references the record.

Until all three hold, retention is indefinite. This rule resolves feature 01's membership-
tombstone blocker without allowing an offline device to resurrect a row.

### `sync_long_text_holds`

Authority-owned and replicated to eligible editors: campaign ID, resource class, record ID, field
path, holder user/session IDs, acquired/renewed/expires timestamps, and monotonically increasing
hold version. Unique `(campaign_id, resource_class, record_id, field_path)` permits one active hold.

Holds last 120 seconds, renew every 30 seconds while the editor is active, and expire exclusively at
`database_now >= expires_at`. Explicit takeover increments the hold version and immediately ends the
previous holder's write authority. Unsaved client text remains local and is never overwritten.

## Mutation and Audit Atomicity

The local API records the domain mutation, its queue row, and its feature 06 audit event in one
SQLite transaction. At upload, the backend applies the domain mutation and public/private audit
event in one PostgreSQL transaction. An audit transport outage cannot reject the local operation;
the atomic envelope remains pending. A server business rejection marks both as rejected and raises
one conflict/error outcome.

## Conflict and Capacity Policy

- Version conflict: preserve both values in `sync_conflicts`; offer `keep authority`, `resubmit my
  value against current version`, or `edit a merged value`, when the resource renderer supports it.
- Semantic `delta` operations use stable mutation IDs and apply exactly once; clamp is evaluated
  after ordered deltas against the declared bounds.
- Absolute `set` remains versioned and conflicts.
- Long text requires an active hold and expected hold version; it does not use CRDT in MVP.
- The 10 MB campaign allocation covers pending mutations, conflicts, tombstones, cursors, and holds.
  Accepted terminal queue payloads compact immediately after acknowledgement. Tombstones compact
  only under the watermark rule. If unresolved data reaches 10 MB, new offline writes are blocked
  with a clear `storage_full` error; confirmed mutations are never evicted.

## Replica Deletion and Privacy

Membership revocation or sign-out atomically marks a replica `dropping`, closes readers/workers,
deletes its replicated tables, pending payloads, conflicts, cached role, and attachment local-state
references, then removes the campaign state row. Attachment bytes are deleted by feature 05 using
the same revocation signal. Upload rejects mutations from revoked actors even if local cleanup has
not completed.

Sync rules are generated by feature 04 declarations. Hidden rows, counts, and tombstones never
reach an unauthorized replica.

## Server Infrastructure and Migration

- PostgreSQL runs logical replication with a dedicated least-privilege publication/user.
- The sync service has its own operational store and credentials; those are not application domain
  tables or exports.
- The upload endpoint is the only path from client queue to PostgreSQL and re-authorizes every
  mutation using current membership and visibility.
- SQLite schema changes use versioned, transactional local migrations. A failed local migration
  leaves the old replica usable or triggers a safe re-download; it never partially upgrades.
- Provider-managed schema and static sqlite-wasm worker assets are pinned and verified in build.

Rollout first creates server sync infrastructure and bookkeeping tables, then enables one fixture
resource, then memberships/visibility, then feature tables. A rollback disables subscriptions and
returns consumers to the in-memory repository only in non-production development; production data
continues to use forward migrations.

## Retention

| Data | Rule |
| --- | --- |
| Pending mutation | Until accepted acknowledgment or explicit conflict resolution |
| Conflict | Until resolved, synchronized, and 30 days old |
| Accepted queue metadata | Compact payload immediately; delete metadata after 7 days |
| Rejected transport attempts | Retry with backoff; never expire a confirmed mutation |
| Tombstone | Watermark rule plus 90-day minimum |
| Hold | Delete 24 hours after expiry/release; it carries no content |
| Revoked replica | Delete immediately on observed revocation |

## Required Data Tests

- OPFS worker and forced IndexedDB fallback survive browser restart.
- Queue insertion and local domain/audit write are atomic.
- Queue drain is causal and mutation IDs are idempotent across lost acknowledgements.
- Deferred conflict preserves both versions and never silently reverts local state.
- Semantic operations apply exactly once and respect bounds.
- Tombstone purge refuses any row below an eligible device watermark or referenced by a mutation.
- Revocation removes every campaign-local table and blocks queued upload.
- Player replicas contain no GM-only row, count, or tombstone.
- 10 MB pressure blocks new writes without evicting confirmed pending work.
- Local migration failure is recoverable without partial schema state.

