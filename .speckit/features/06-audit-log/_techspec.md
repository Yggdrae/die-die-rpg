# TechSpec: Audit Log

Source: `_prd.md`, `_bdd.md`, `_db.md`, frozen audit contracts, and features 03/04 specs.

## Current Facts

- `AuditEvent` and non-blocking `AuditRecorder` exist in `@rpg/contracts`.
- As of 2026-10-26, `packages/audit` provides the two stores and renderer registry (task 01), the
  durable recorder with in-transaction mutation envelopes (task 02), and the authorized query API
  (task 03); task 04 adds separate audit streams and local compaction, task 05 the log UI, task 06
  contributor registrations, a conformance inventory, and report-only retention. On 2026-10-28
  replicas acknowledge synced audit rows through feature 03's ack route (event ID, resolved to a
  sequence server-side) and a deletion executor exists, off unless `AUDIT_RETENTION_DELETE=true`.
- The frozen contract has a `private` routing flag and client `at`; it has no authority sequence or
  renderer version. These remain persistence/module metadata and do not require changing the event
  shape returned by contributors.

## Proposed Architecture

Add `packages/audit` with:

- `AuditService` implementing `AuditRecorder` and routing to campaign/private stores;
- `AuditEnvelopeParticipant` for feature 03 atomic mutation envelopes;
- two PostgreSQL/local repositories with no shared broad read adapter;
- `AuditRendererRegistry` keyed by action/version;
- `AuditQueryService` applying feature 04 target visibility before pagination/counts;
- retention/local-compaction jobs.

Contributors register payload schema and renderer through the public package entry point. They never
write audit tables or control sequence/retention. Feature 06 never imports contributor internals.

## Recording Contract Adaptation

The existing `AuditRecorder.record()` remains non-throwing to callers. Application composition
wraps an event with origin mutation ID, target visibility snapshot, and renderer version, then
places it in feature 03's durable envelope. Online-only mutations use the same envelope abstraction
against PostgreSQL. Stable event ID is derived/generated once before retry.

`private=true` routes only to the private repository; `false` routes only to campaign audit. No
code path chooses a table during reads based on a client flag.

## API

| Method | Path | Authorization | Purpose |
| --- | --- | --- | --- |
| GET | `/campaigns/:campaignId/audit` | current member plus per-target read | campaign-visible log |
| GET | `/campaigns/:campaignId/audit/private` | GM role plus per-target read | GM-private log |
| GET | `/campaigns/:campaignId/sessions/:sessionId/audit` | current member plus per-target read | session scope |

Queries accept cursor, limit, actor ID, target type, and target ID. Cursor is authority campaign
sequence, not timestamp/offset. The cursor token is the last returned event ID, resolved server-side
to its sequence among permitted rows only; raw sequence values are not returned, because gaps would
disclose hidden events. Each event is decided on its target's current feature 04 facts and on its
stored snapshot (the snapshot narrows, never widens); the private route additionally requires a
GM-only read of the campaign. Undeclared target classes fail closed (task 03). Server filters
authorization before producing rows, totals, or next cursor. Raw before/after JSON is never
returned directly; renderer output is a safe structured description with optional
already-authorized display values.

## Persistence, Sync, and Retention

Implement `_db.md`: physically separate stores, sequence allocator, immutable privileges/triggers,
365-day server retention (approved 2026-10-28), and 10 MB local compaction preserving pending and 90-day rows.

Feature 03 synchronizes a domain mutation and its audit envelope together. Feature 04 supplies
target predicates. Player subscription configuration cannot address the private table. Offline
query merges pending local events by causal sequence with accepted authority sequence and labels
pending state honestly.

Audit remains derived: domain transactions never read it to make business decisions, and losing an
event cannot corrupt domain state. There is no blob, CRDT, or general realtime requirement.

## Failure Handling and Observability

- Recorder validation/routing failure is swallowed at caller boundary, persisted to restricted
  repair/dead-letter state where possible, and raises an operator alert.
- Missing renderer uses a safe generic output; invalid renderer output fails closed.
- Retention failure grows backlog but never blocks campaign mutations.
- Metrics: event/routing outcomes, repair backlog, sequence contention, query latency, compaction,
  retention. No actor/content values in metric labels.
- Logs contain event/mutation IDs and safe codes, never before/after payloads.

## Testing

- Unit: routing, schema/renderer registry, safe fallback, cursor/filter behavior.
- PostgreSQL: idempotency, sequence under concurrency, immutability privileges/triggers, retention.
- Sync/security: zero private rows/table access on player replicas; hidden target events/counts absent.
- Failure injection: audit adapter unavailable, renderer throws, retention fails, lost acknowledgement.
- Contract: each required P0 contributor registers every significant event type.
- Playwright: GM explains a resource change; player sees only permitted history; offline event later
  appears once with stable order.

## Impacted Areas

- `packages/audit/` — new package, schemas/migrations, services, renderer/test kit.
- `apps/api/src/modules/audit/` — query routes and composition.
- `apps/web/src/features/audit/` — campaign/session log and filters.
- `packages/sync/` — atomic audit envelope and separate subscription rules.
- Mutating feature packages — registrations and recorder calls only.

## Decisions and Blockers

- Audit is excluded from P0 export.
- Roll results have one authoritative owner in feature 09 and may emit summarized audit events;
  feature 06 does not duplicate full roll records.
- Server retention is 365 days: Approved (2026-10-28, delegated by owner). Deletion runs only when
  an operator sets `AUDIT_RETENTION_DELETE=true` (runtime option `auditRetention.delete`, default
  off); otherwise the maintenance job is report-only. Blocked groups (unacknowledged replica,
  pending reference, no watermark evidence) are never deleted.
- Membership events (`campaign_membership`) are readable by GM roles only: Approved (2026-10-28,
  delegated by owner).

