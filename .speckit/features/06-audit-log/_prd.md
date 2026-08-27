# PRD: Audit Log

Source: `PRD.md` s.30, s.48, s.67, s.75, s.87 Test 7.
Track: A. Depends on: `AuditEvent` contract from feature 00, `ActorRef` from feature 01.

## Problem

Two different needs collapse into one mechanism. Operationally, a GM needs to answer "what
happened, and who did it" when a resource is wrong or a reveal was premature (`PRD.md` s.67).
Structurally, the platform requires auditability as a security property (`PRD.md` s.75).

There is a third need that makes this feature non-trivial: some GM actions must be logged without
being visible to players (`PRD.md` s.48, s.67). A single log with a filter is the wrong shape,
because a filter is a display decision and players must never receive the rows at all.

## Goals

- Every significant state change is attributable to an actor and a time.
- A GM reads a plain-language history of a session without opening a database.
- GM-private actions are recorded in a store that never synchronizes to a player device.
- Any feature contributes audit events by declaring them, without owning storage or retention.

## Non-Goals

- Undo or rollback. The log records what happened; it does not reverse it.
- A general event-sourcing architecture. Entities remain the source of truth; the log is derived
  and additive.
- Application performance monitoring, error tracking, or infrastructure logs.
- The timeline feature (`PRD.md` s.42), which is in-fiction chronology and is deferred to V1.
  The audit log is out-of-fiction and factual.
- Analytics on player behaviour.

## Users and Context

### Primary user

A GM, mid-session or after it, reconstructing what changed. Reads it rarely, and when they do,
they are already confused or suspicious, so clarity matters more than completeness.

### Secondary users

Players, who may see the non-private log for their campaign where the underlying content is
visible to them. Developers and operators investigating a defect or a permission question.

## User Stories

- As a GM, I want to see that a player resource went from 6 to 2 at 14:35, so that I can tell
  whether a rule was applied twice.
- As a GM, I want to see who revealed a handout and to whom, so that a premature reveal is explainable.
- As a GM, I want my hidden actions recorded where players cannot see them, so that I can review
  my own interventions without exposing them (`PRD.md` s.48).
- As a player, I want to see the public history of my own character, so that I trust the numbers.
- As an operator, I want membership and permission changes recorded, so that an access question
  has an answer.

## Functional Requirements

### P0 — MVP

- FR-001: Append-only audit event store. Events are never updated or deleted by application code.
- FR-002: Event shape from feature 00 `AuditEvent`: actor, action, target type, target id,
  before, after, timestamp, campaign, session when applicable, and the `private` flag.
- FR-003: Two separate stores, not one store with a flag on the read path: a campaign audit log
  subject to feature 04 visibility, and a GM-private log that never synchronizes to a non-GM
  device (`PRD.md` s.67).
- FR-004: A published module API for recording an event, consumed by every feature that mutates
  state. Recording is the caller responsibility; storage, ordering, and retention are not.
- FR-005: Events recorded for at least: membership and role changes (01), campaign creation,
  deletion and system version change (02), visibility and reveal changes (04, 17), attachment
  upload and delete (05), character resource and field changes (15), entity create, update and
  delete (16), session start and end (18), encounter changes (19), and roll results (09).
- FR-006: Human-readable rendering per event type, contributed by the owning feature, so the log
  reads as "GM revealed Weathered Letter to Player A" rather than as a field diff (`PRD.md` s.67).
- FR-007: Campaign-scoped and session-scoped log views, in reverse chronological order, filterable
  by actor and by target.
- FR-008: Events are recorded through the same offline path as their originating mutation, so an
  offline action is logged when it happens and synchronizes with its mutation (`PRD.md` s.76).
  A log entry and its mutation must not arrive separately.
- FR-009: Recording an event must never block or fail the originating operation. A failed write
  degrades to a retry, not to a rejected user action.

### P1 — Important

- FR-101: Export of the audit log with the campaign (`ExportableModule`, feature 07).
- FR-102: Retention and archival policy for old events.
- FR-103: Grouping of related events into one entry, so a multi-effect action reads as one line.

### P2 — Later

- FR-201: Undo built on recorded before-values, if a concrete need appears.
- FR-202: Tamper-evident logging.

## Behavioral Constraints

- Append-only. No update path, no delete path outside retention.
- The private log is a separate store with its own sync rule that excludes non-GM roles entirely
  (`PRD.md` s.34). Hiding private rows in the interface is not acceptable.
- The log is derived. Losing it must never corrupt domain state, and rebuilding domain state
  from it is not a supported operation.
- Before and after values inherit the visibility of their target. An audit entry must not become
  a side channel that leaks a hidden value.
- Ordering within a campaign must be stable and independent of client clock skew.
- Volume must be bounded. A per-keystroke or per-render event is a defect; events mark meaningful
  state changes (`PRD.md` s.67).

## Data and Privacy Considerations

- The log contains actor identity and content diffs, which is the most sensitive derived data in
  the product.
- The private log exists specifically so that hidden GM mechanics remain hidden (`PRD.md` s.48, s.86).
  A leak of it spoils the game, which is the product failure this feature exists to prevent.
- Player-visible logs must not become a behavioural record of players beyond game state changes.
- Retention needs a bound; an unbounded log grows the local database and degrades the cold start
  budget in `PRD.md` s.79.

## Success Signals

- `PRD.md` s.87 Test 7: a clock advance from 3 to 4 appears in the audit log with actor and time.
- A GM can answer "why is this resource wrong" from the log alone, without developer help, in
  the validation campaign.
- Zero private log rows present in a non-GM local database.
- Zero user-facing operations failed because audit recording failed.

## Rollout

Wave 4, Track A. The `AuditEvent` contract is frozen in wave 0, so features built in waves 1 to 3
record events from the start against a local no-op or local-store implementation and gain the real
store without changing call sites. Rendering contributions (FR-006) arrive per feature as each lands.

## Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Private events written to the shared log by mistake | Hidden GM mechanics exposed, unrecoverable spoiler | Separate store, not a flag on a shared read path (FR-003); a test asserts no private rows sync to a player device |
| Audit writes coupled to user operations | A logging failure blocks play | Non-blocking write with retry (FR-009) |
| Log volume unbounded | Local database bloat, s.79 cold start regression | Events mark meaningful changes only; retention policy in P1, bound decided in tech spec |
| Before and after values leak hidden content | Audit becomes a side channel around feature 04 | Diff values inherit target visibility; redaction where the target is hidden from the reader |
| Every feature invents its own event vocabulary | The log becomes unreadable | Event types registered per feature with a required human-readable renderer (FR-006) |

## ADR Candidates

- Two physical stores for public and private audit, versus one store with row-level filtering.
  The alternative is plausible and cheaper; the failure mode is a permanent spoiler, which is
  why the decision deserves a record.

## Open Questions

- TODO: Retention window for audit events, and whether it differs between the public and private stores.
- TODO: Whether the audit log is included in `.rpgpack` export by default (`PRD.md` s.65 does not list it).
- TODO: Whether roll results live in the audit log, in the session log (feature 18), or in both.
  Duplication here would double volume for the most frequent event in the product.
