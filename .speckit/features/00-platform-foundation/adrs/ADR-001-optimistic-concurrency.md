# ADR-001: Optimistic concurrency with an explicit version, plus semantic operations

- Status: Accepted
- Date: 2026-08-27

## Context

The product is local-first by requirement, not by preference. `PRD.md` s.5.3 states that losing
connection must not interrupt a session in progress, and s.52 puts the local database on the read
and write path so no user action waits for a server.

That makes concurrent divergence normal rather than exceptional. A GM and an assistant GM edit
the same NPC. A player takes damage while offline. Two clients reconnect in the wrong order.

`PRD.md` s.80 sets the acceptance bar: **zero silent overwrites**, and conflicts that cannot be
resolved automatically must be presented to the user explicitly.

Twenty features persist data. Whatever this decision is, they all inherit it, and it cannot be
retrofitted: a record that never carried a version cannot gain conflict detection without a data
migration across every table.

## Decision

Three parts, all frozen in `packages/contracts` in wave 0.

**1. Every persisted entity carries an integer `version`.**
`EntityEnvelope` requires it. It starts at 1 and increments on every successful write.

**2. `SyncedRepository` requires `expectedVersion` on every write.**
`upsert(value, expectedVersion)` and `softDelete(id, expectedVersion)`. The parameter is
required, not optional. A stale version returns a typed `VersionConflict` carrying both the
expected and the actual version, and leaves stored state untouched.

**3. Play-driven state changes are expressed as `SemanticOp`, not absolute writes.**
`delta`, `set`, `clamp`. Damage is `delta(-3)`, not `set(4)`. Two people adjusting the same
resource offline then merge instead of destroying each other's change.

A fourth part was added before the tag, as a direct result of the wave 0 spike: see Follow-up.

## Alternatives Considered

### Last-write-wins

- Advantages: nothing to implement, no conflict UI, no version column, and it is the default
  behaviour of most sync layers including the one chosen.
- Disadvantages: silently destroys work. The loss is invisible at the moment it happens and
  usually discovered by the user, mid-session, as a number that is wrong.
- Reason rejected: directly contradicts `PRD.md` s.80. It is also the alternative that gets
  chosen by accident — by making `expectedVersion` optional, or by writing a resource with `set`
  when `delta` was meant — which is why the contract makes it require deliberate effort.

### Full CRDT for the whole domain model

- Advantages: automatic merge everywhere, no conflict surface to build.
- Disadvantages: significant complexity for every entity; poor fit for records with invariants,
  where a merged result can be individually valid and jointly nonsense; larger payloads and
  storage, which the local database budget cannot absorb.
- Reason rejected: `PRD.md` s.57 and s.58 scope CRDT to collaborative text only, and s.58 states
  explicitly that Yjs will not be used for the whole domain model. Deferred to V1 for prose.

### Server-authoritative writes with no local write path

- Advantages: one source of truth, conflicts impossible by construction.
- Disadvantages: every user action waits for the network.
- Reason rejected: contradicts `PRD.md` s.5.3 and s.76. The product exists to work at a table
  with no signal.

## Consequences

### Positive

- A stale write is a typed value a feature must handle, not a silent success.
- Counter and resource changes merge correctly across offline clients, which is the common case
  at a table.
- Tombstones plus versions make deletes safe to synchronize (`PRD.md` s.57).
- The rule is enforceable at review time, because an absolute write to a resource is visible in a
  diff.

### Negative / Tradeoffs

- Every feature carries `version` plumbing it would otherwise not need.
- Someone must build the shared conflict surface before any feature can present a conflict; that
  is feature 03 FR-009, and features that ship earlier have to tolerate its absence.
- Semantic operations are more work than an absolute write, and the temptation to use `set` will
  recur under deadline pressure.
- `version` is per record, not per field. Two people editing different fields of the same NPC
  still conflict. Accepted for MVP; field-level merge is not worth its cost yet.

## Follow-up

**A synchronous result is not the whole story.** The wave 0 spike established that the sync
provider is asymmetric: reads flow server to client, but writes queue locally and upload to a
backend the application owns. An offline write succeeds locally, the interface reports success,
and the server rejects it on upload — observed as
`{"op":"CONFLICT","expectedVersion":1,"actualVersion":4}`
(`../spike-findings.md`, Finding 1).

So `SyncedRepository` also carries a `conflicts` channel of `DeferredConflict`. `upsert` returning
ok is not proof the server accepted the write. Features observe the channel; feature 03 owns the
presentation.

Without this addition, every feature would have trusted the return value and `PRD.md` s.80 would
have been violated on the offline path — the exact case the local-first architecture exists to
serve.

**Revisit when:** field-level conflicts become a real complaint from validation sessions
(`PRD.md` s.81), or when Yjs lands in V1 and the boundary between CRDT text and versioned
structure needs restating.
