# Task 04: Separate synchronization and local compaction

Status: completed (2026-10-27). Only target classes the provider can prove replicate (today
`campaign`); the rest stay online-only through the task 03 API (see Design).

## Scope

- Register independent campaign/private sync rules and local tables.
- Merge pending local and accepted authority order honestly.
- Implement 10 MB compaction preserving pending and newest 90-day history.
- Test player database absence, revoked membership cleanup, and partial-history marker.

## Acceptance Criteria

- [x] Player replicas cannot address or contain private rows/table metadata.
- [x] Hidden events/counts/tombstones never arrive.
- [x] Compaction never evicts pending events or moves rows between stores.

## Verification

```bash
bun test packages/audit packages/sync
bun run typecheck
```

## Design

- Migration `0007_audit_sync_publication`: both event tables join the `powersync` publication with
  `SELECT` for `powersync_replicator`; account store, allocators and outbox stay unpublished.
- `compileAuditProviderQueries` (`packages/sync/src/sync-rules.ts`) compiles, per store and per
  registered class, the same three decisions as `AuditTargetAccess`: the target's current row and
  class rule (join to the target source, live, keyed by the subscribed campaign), the stored
  snapshot applied as Visibility (`json_extract`), and GM reading roles for the private store.
  Streams `campaign_audit` / `gm_private_audit` in `infra/powersync/sync-config.yaml`, both
  `auto_subscribe: false`, windowed by `subscription.parameter('campaign_id' | 'month')`.
- Safe narrowing (verified with the service engine and the live service): PowerSync 1.25.0 does not
  enforce an equality between a joined row and the audit row, and an unkeyed target join hits the
  1000-parameter limit. So only classes whose record is the campaign itself (`campaignColumn = id`)
  replicate; `server_only`, Ownership Rule on read, party targeting and per-record classes are
  excluded with a reason (`excluded`) and remain readable online only. Membership events never sync.
- Projection excludes `campaign_sequence` (gaps count hidden events), the snapshot, and the origin
  mutation; local order is `accepted_at`, then id.
- Browser (`packages/sync/src/audit-replica.ts`, `browser.ts`): `replicaSchema({ privateAudit })`
  creates `audit_private_events` only while a cached role is a GM role (schema switched while
  disconnected); `AuditWindowManager` subscribes windows and never addresses the private stream for
  a player; `planAuditWindow` keeps the newest 90 days, then older months within 10 MB (both
  stores, bytes x 2), evicting by forgetting subscriptions; `AuditReplicaStore.read` merges pending
  queue events (labeled pending/conflicted/rejected) above accepted rows and reports `partial`;
  window state in local-only `sync_audit_window`, dropped with the campaign on purge.

## Evidence (with `.env`, 2026-10-27)

- `bun test packages/audit packages/sync`: 168 pass, 7 skip (engine opt-in), 0 fail.
- New/updated tests:
  - `packages/sync/src/audit-replica.test.ts` (11): window planning (90 days above budget,
    eviction by age, growth, history start), merged read with labels and filters, private
    unavailable without the table, usage across stores, player never addresses the private stream,
    demotion forgets private windows, compaction leaves pending events and both tables untouched.
  - `packages/sync/src/sync-rules.test.ts` (+5): audit rendering, exclusions, private narrowing,
    PostgreSQL dialect, projection guards, party.
  - `apps/api/src/modules/sync/audit-sync.integration.test.ts` (4): drift gate, exclusions,
    6 tampered configs reported, PostgreSQL shadow replicas vs `AuditTargetAccess` for 9 requesters
    (observer included) x 2 stores x 7 snapshots x 2 months; engine truth table on the same fixture
    (with `POWERSYNC_ENGINE_EXEC`: 5 pass).
  - `sync-config.powersync.integration.test.ts` (+1, live): GM/player/removed member, projection,
    no private stream/table/id in a player's stream, forged private subscription empty, hidden
    inserts leave a player's ops/counts/checksums unchanged, month eviction, revocation, deleted
    target. 5/5 pass.
  - `apps/web/e2e/live-sync.e2e.ts` (+1, live browser): player SQLite has no `audit_private*` object,
    untyped row or subscription; owner has the private table and row; revocation empties the
    player's audit rows and windows. 8/8 pass.
  - Publication, replication-role, `sync-boundary.test.ts` updated.
- Mutation checks: dropping the snapshot clause fails 2 tests; dropping the private GM narrowing
  fails 4.
- `bun run typecheck`: 10/10.

## Gaps

- Per-record classes (feature 16 entities etc.) cannot replicate audit until the provider can key a
  target join by two columns; their history is online-only.
- Eviction granularity is one month; size is an estimate (column bytes x 2), not a physical measure.
- Offline local entries render a generic description (browser has no contributor renderers).
