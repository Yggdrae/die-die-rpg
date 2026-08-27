# PRD: Offline-First Sync Platform

Source: `PRD.md` s.5.3, s.52, s.53, s.54, s.55, s.57, s.61, s.76, s.79, s.80, s.87 Tests 2, 4, 6.
Track: A. Depends on: contracts from feature 00 only.

## Problem

A table runs in a basement, on hotel wifi, on a phone tether. `PRD.md` s.5.3 states the product
rule plainly: losing connection must not stop a session in progress. A conventional request-response
application fails that rule on the first dead spot, and the failure lands at the worst moment.

The second problem is correctness under concurrency. A GM and an assistant GM edit the same NPC,
a player takes damage while offline, two clients reconnect in the wrong order. Last-write-wins
silently destroys work, and `PRD.md` s.80 sets the target at zero silent overwrites.

This feature owns the answer to both, once, so that nineteen other features never think about it.

## Goals

- Every read and write during a session hits the local database first, with no server round trip
  (`PRD.md` s.52).
- A previously synchronized campaign is fully usable with no network (`PRD.md` s.76).
- Session Mode is usable within p95 under 2 seconds from a cold app open on a warm local database
  (`PRD.md` s.79).
- Zero confirmed offline mutations are silently discarded, and zero structured conflicts are
  silently resolved by overwrite (`PRD.md` s.80).
- The domain never imports a sync provider API. Provider replacement is a change in one boundary
  (`PRD.md` s.55).

## Non-Goals

- Collaborative text merge. Yjs is V1 (`PRD.md` s.57, s.71). MVP treats long text as a structured
  field under optimistic concurrency and surfaces the conflict rather than merging it.
- Presence, cursors, typing indicators, dice animations. Ephemeral realtime is V1 (`PRD.md` s.56).
- Attachment binary synchronization. Feature 05 owns offline attachment states.
- Peer-to-peer or server-less operation. There is a server; it is simply not on the read path.
- A generic offline framework for future applications.

## Users and Context

### Primary user

A GM running a session with unreliable or absent connectivity, who must not notice the difference.

### Secondary users

Players updating their own sheets offline; developers of the other nineteen features, who consume
`SyncedRepository` and never touch the provider.

## User Stories

- As a GM, I want the application to keep working when the wifi drops, so that the session continues.
- As a player, I want my sheet edit to apply instantly, so that the interface does not feel remote.
- As a player, I want my offline changes to arrive after reconnection, so that nothing I did is lost.
- As a GM, I want to be told when my edit conflicts with the assistant GM edit, so that I decide
  which version survives instead of discovering a silent loss later.
- As a GM, I want to know whether I am synchronized, so that I can trust the state before ending a session.

## Functional Requirements

### P0 — MVP

- FR-001: Local database in the browser using SQLite/WASM, persisted through OPFS, with an
  IndexedDB-backed VFS fallback where OPFS is unavailable (`PRD.md` s.53).
- FR-002: PostgreSQL as the shared authoritative relational store (`PRD.md` s.54). Binary content
  never enters it; feature 05 owns blobs.
- FR-003: A `SyncService` boundary implementing the `SyncedRepository` contract from feature 00.
  No feature outside this one references PowerSync (`PRD.md` s.55, s.61).
- FR-004: Initial synchronization of a campaign to the local database on join or open.
- FR-005: Incremental synchronization from PostgreSQL to local SQLite while connected.
- FR-006: Durable local write queue for mutations made while offline, surviving application restart.
- FR-007: Automatic reconnection and queue drain, in an order that preserves causality within a campaign.
- FR-008: Optimistic concurrency for structured entities using the `version` field. An update
  based on a stale version produces an explicit conflict, never an overwrite (`PRD.md` s.57).
- FR-009: Conflict surface: an unresolvable structured conflict is presented to the user with both
  versions and an explicit choice. It is never resolved silently (`PRD.md` s.80).
- FR-010: Semantic operations for counters and resources using `SemanticOp` from feature 00, so
  that concurrent damage and healing merge instead of clobbering (`PRD.md` s.57).
- FR-011: Soft delete with tombstones for synchronized deletes (`PRD.md` s.57).
- FR-012: Synchronization status indicator: synchronized, pending count, offline, error.
- FR-013: Sync rules enforce permissions and visibility server-side, so a client never receives
  data it is not allowed to see (`PRD.md` s.34, s.60). The rule definitions are owned by feature 04;
  this feature enforces them at the sync boundary.
- FR-014: Local database is dropped for a campaign when membership is revoked.
- FR-015: Offline capability for the flows listed in `PRD.md` s.76: open a synchronized campaign,
  view and edit sheets, create notes, roll dice, read cached rules, start an encounter, change
  resources, execute actions, continue a session.

### P1 — Important

- FR-101: Background synchronization while the application is not in the foreground, where the
  platform allows it.
- FR-102: Selective synchronization, so a device with many campaigns does not carry all of them.
- FR-103: Conflict history, so a resolved conflict remains inspectable.

### P2 — Later

- FR-201: Yjs integration for collaborative text (`PRD.md` s.57, s.58, V1).
- FR-202: Sync provider replacement, exercised rather than assumed.

## Behavioral Constraints

- The user-facing read and write path is local. A server round trip in that path is a defect.
- A mutation confirmed by the interface must never be silently discarded (`PRD.md` s.80).
- Permission enforcement happens on the server and in the sync rules, never only in the interface
  (`PRD.md` s.34). A client-side filter is a display concern, not a control.
- No feature may bypass `SyncedRepository` to reach PostgreSQL or the local database directly.
- Any entity that reaches the sync layer must carry `version` and `deletedAt` from feature 00 FR-003.
  Retrofitting them later is not possible without a data migration across every feature.
- Clock skew between clients must not decide conflicts. Version and server ordering decide.

## Data and Privacy Considerations

- The local database contains campaign content, including GM-only material, on the device of
  whoever synchronized it. Sync rules must never send GM-only data to a player device, because
  once it is local, hiding it in the interface is not a control (`PRD.md` s.34, s.37).
- Local data is cleared on sign-out and on membership revocation.
- The pending mutation queue can contain user content and must be cleared with the campaign.
- Retention of tombstones needs a bound; unbounded tombstones grow the local database indefinitely.

## Success Signals

- `PRD.md` s.79: p95 under 2 seconds from cold open to usable Session Mode, installed PWA, offline,
  warm local database, typical campaign dataset, excluding attachment download.
- `PRD.md` s.87 Test 4: a player performs a character update, a note creation, and a roll while
  offline; the interface stays operational; all three arrive consistently after reconnection.
- `PRD.md` s.87 Test 6: simultaneous structured edits produce an explicit conflict, not a silent overwrite.
- `PRD.md` s.87 Test 2: a player resource change reaches the GM, and a player without permission
  cannot make it.
- Zero silent overwrites in the validation campaign (`PRD.md` s.80).

## Rollout

Wave 3, Track A, and the single largest risk in the plan. Mitigated by three decisions taken earlier:
the `SyncedRepository` contract is frozen in wave 0, a throwaway feasibility spike runs in wave 0
(feature 00 FR-011), and features in waves 1 and 2 run against a local-only implementation of the
same contract. Shipping this feature swaps the implementation; consuming features do not change.

If the spike fails, this feature is redesigned before nineteen features are written against it,
which is the entire reason the spike happens in wave 0.

## Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| PowerSync does not fit the permission model | Core architecture rework late in the plan | Wave 0 spike covering a GM-only record and a player device; `SyncService` boundary keeps replacement viable |
| OPFS unavailable or unreliable on a target browser | Offline promise fails on real devices | IndexedDB-backed VFS fallback (FR-001); measure s.79 on the fallback path too |
| Features bypass the repository contract under deadline pressure | Offline and conflict guarantees become partial and unprovable | Architecture guard from feature 00 FR-009; review gate on any direct database access |
| Conflict surface built late, so features have no path for it | Conflicts silently resolved, violating `PRD.md` s.80 | Conflict presentation is P0 here, not per feature; features receive a conflict result and hand it to the shared surface |
| Local database holds GM-only data on a player device | Information leak that no interface fix can undo | Sync rules filter server-side (FR-013); a test asserts absence of GM-only rows on a player device |
| Tombstone and queue growth unbounded | Local database bloat, slow cold start, s.79 regression | Retention bound decided during tech spec; measured against the validation dataset |

## ADR Candidates

- PowerSync as the initial sync provider, behind a `SyncService` boundary (`PRD.md` s.55, s.91).
- Per-data-type conflict strategy: optimistic concurrency for structured entities, semantic
  operations for counters, CRDT deferred to V1 for text (`PRD.md` s.57).
- OPFS as preferred local persistence with an IndexedDB fallback (`PRD.md` s.53).

## Open Questions

- TODO: Tombstone and mutation queue retention policy, and local database size budget for a
  typical campaign.
- TODO: Whether long text fields in MVP are edited under optimistic concurrency with a conflict
  surface, or are single-writer-locked until Yjs lands in V1.
- TODO: Ordering guarantees required across features when a queue drains, beyond per-campaign causality.
- TODO: Target browser and device matrix for the s.79 measurement.
