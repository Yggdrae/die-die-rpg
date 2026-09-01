# Data Design: Audit Log

Source: `_prd.md`, `_bdd.md`, feature 03 `_db.md`, feature 04 `_db.md`, and the frozen
`AuditEvent`/`AuditRecorder` contracts.

## Sources of Truth and Separation

Audit is derived, not the source of domain state. PostgreSQL holds two physically separate P0
tables. Separate sync publications/rules ensure a private row cannot reach a player device. The
`private` contract field selects the table at the write boundary and is not used as a read filter
over one shared table.

| Store | Eligible readers | Sync destination |
| --- | --- | --- |
| Campaign audit | Members allowed to see the referenced target | Only eligible member replicas |
| GM-private audit | owner/gm/assistant_gm subject to target rules | GM-role replicas only |

## PostgreSQL Schema

The two tables have the same columns but no shared parent/partition that a broad query could expose.

### `audit_campaign_events` and `audit_private_events`

| Column | Constraints / meaning |
| --- | --- |
| `id uuid` | primary key; generated with originating mutation |
| `campaign_id uuid` | indexed scope |
| `session_id uuid` | nullable indexed scope |
| `campaign_sequence bigint` | stable authority-assigned order |
| `actor_user_id uuid`, `actor_role text` | actor snapshot at mutation time |
| `action text` | registered stable event type |
| `target_type text`, `target_id uuid` | opaque resource reference |
| `target_visibility jsonb` | validated snapshot used for filtering/redaction |
| `before_value jsonb`, `after_value jsonb` | nullable validated/redacted metadata |
| `client_recorded_at timestamptz` | contract `at`; informational, never ordering |
| `accepted_at timestamptz` | authority time |
| `origin_mutation_id uuid` | idempotency/correlation key |
| `renderer_version integer` | registered payload rendering version |

Unique `(campaign_id, campaign_sequence)` and unique `origin_mutation_id` per store. Indexes support
`(campaign_id, campaign_sequence DESC)`, `(session_id, campaign_sequence DESC)`, actor filtering,
and target filtering. Sequence values come from a campaign-scoped allocator row locked in the same
transaction; client clocks never decide order.

Application roles cannot update/delete these tables. The application database role receives
insert/select only; retention runs under a separate maintenance role. Database triggers reject
UPDATE and application DELETE as defense in depth.

## Write Path and Failure Isolation

Every auditable domain mutation carries an audit payload in feature 03's durable mutation envelope.

- Offline/local: domain row, mutation queue entry, and audit payload record atomically in SQLite.
- Authority: domain write, campaign sequence allocation, and exactly one routed audit insert commit
  in the same PostgreSQL transaction.
- Idempotency: retry by `origin_mutation_id` returns the existing event.
- Business rejection: no accepted event is inserted; the rejected envelope remains correlated to
  the conflict/error outcome.
- Audit adapter outage before authority upload leaves the envelope pending and does not roll back a
  locally confirmed user action. Unexpected audit insertion failure is recorded in a restricted
  repair outbox within the domain transaction when possible; domain state remains authoritative.

The last fallback means a catastrophic logging defect can create a gap, but never block play or
fabricate history. A metric/alert makes the gap explicit.

## Visibility and Redaction

The caller supplies target visibility and already-redacted before/after metadata using its
registered event schema. Feature 06 validates both. Read and sync rules call feature 04 declarations
for the target class; a missing declaration fails closed.

- Hidden events are absent, not placeholder rows.
- Counts are computed after authorization.
- Private table rows never enter player sync publications, including tombstones.
- Author-private target events follow the target's author-only rule even in the campaign table.
- Renderer failure yields a generic description without exposing raw JSON.

## Local SQLite and Budget

Replicas use separate `audit_campaign_events` and `audit_private_events` tables. Players do not
create the private table or subscription. Local ordering uses authority sequence when accepted and
the feature 03 causal sequence for pending local events.

Feature 06 owns 10 MB of the frozen campaign budget. Local compaction keeps:

1. all pending/unaccepted events;
2. all events from the most recent 90 days;
3. then newest events until 10 MB is reached.

Older accepted rows may be evicted locally and re-fetched online. The UI states when local history
is partial. Private and campaign stores share the 10 MB ceiling but never exchange rows.

## Server Retention

P0 PostgreSQL retention is 365 days from `accepted_at`. Maintenance deletes only rows older than
the boundary and only after all eligible sync subscribers acknowledge a cursor beyond them. This
is retention, not application deletion, and runs separately for each table. The 365-day default is
a proposed operational policy; changing it requires product approval before implementation.

No archive is created in P0. P1 may add archival/export but cannot weaken private-store separation.
Audit is excluded from P0 `.rpgpack` export.

## Renderer Registry

Event renderers are code registrations keyed by `(action, renderer_version)`. Payload schemas and
renderers remain with the contributing feature; feature 06 stores the stable version and invokes
the public registration. Removing a renderer version requires a migration or permanent generic
fallback for retained rows.

## Migration

1. Create both independent tables, sequence allocator, privileges, and update/delete guard triggers.
2. Register sync rules independently and prove the player publication cannot address the private table.
3. Enable contributor writes behind the recorder adapter; no backfill is fabricated for historical
   mutations that occurred before audit existed.
4. Enable retention only after watermark tests pass; start in report-only mode.

## Required Data Tests

- One mutation retry produces one event by origin mutation ID.
- Client clock skew cannot alter campaign order.
- Private rows/table metadata never reach a player local database.
- Target visibility filters before values, totals, and pagination.
- Application UPDATE/DELETE is rejected; maintenance deletion respects 365 days and watermark.
- Offline domain mutation and audit envelope are atomic.
- Rejected mutation never appears as accepted history.
- Local 10 MB compaction keeps pending and 90-day rows and reports partial history.
- Missing renderer never returns raw private payload.

