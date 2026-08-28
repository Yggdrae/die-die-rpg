# Freeze Decisions

Recorded at the freeze tag per feature 00 FR-008, FR-012, FR-013.
A wave 1 developer should find every answer they need here without asking anyone.

Status: **Frozen. FR-012 and FR-013 ratified. Product decisions recorded.**

---

## FR-013 — Local database size budget

**Budget: 60 MB per synchronized campaign, on disk.**

Measured, not guessed. `bun run --filter @rpg/guard measure` reproduces it.

From the fixture campaign:

| Measured | Value |
| --- | --- |
| Entity record | 390 B |
| Character schema | 1129 B |
| Campaign record | 260 B |

Projected for a typical long campaign (400 entities, 6 characters, 40 sessions):

| Record class | Count | Size | Owner |
| --- | --- | --- | --- |
| Entities | 400 | 0.15 MB | 16 |
| Characters | 6 | 0.01 MB | 15 |
| Rolls | 4 800 | 1.46 MB (est.) | 09 |
| Audit events | 8 000 | 3.05 MB (est.) | 06 |
| **Raw JSON** | | **4.67 MB** | |
| **With SQLite pages, indexes and FTS (x2.2)** | | **10.28 MB** | |

The budget is set at 60 MB, roughly six times the projection, because two inputs are
estimates rather than measurements (roll and audit record sizes — neither feature exists yet)
and because the search index in feature 20 is not counted at all.

**How the budget is spent.** Each feature picks its own retention inside it and never needs to
agree with another:

| Feature | Allocation | What it holds |
| --- | --- | --- |
| 16 entities, 15 characters, 17 handouts, 18 sessions, 19 encounters | 15 MB | campaign content |
| 09 rolls | 10 MB | roll history |
| 06 audit | 10 MB | audit events, both stores |
| 20 search index | 15 MB | derived, rebuildable |
| 03 tombstones and pending mutations | 10 MB | sync bookkeeping |

A feature that needs more asks for a budget revision here; it does not quietly take it.

**Why this matters.** `PRD.md` s.79 sets p95 under 2 s from cold open to usable Session Mode.
The wave 0 spike measured a cold open and read of 5000 rows from OPFS at **8 ms**, so query
speed is not the constraint. Size on disk and the initial sync are. Three append-only features
growing without a shared ceiling is how that target gets missed with no single feature at fault.

Attachments are **not** in this budget. Feature 05 owns offline attachment states and its own
size estimate (`PRD.md` s.77).

---

## FR-012 — Long-text concurrency for MVP

**Decision: single-writer, with an explicit takeover. Not optimistic concurrency.**

Ratified on 2026-08-27.

### Reasoning

Optimistic concurrency is right for structured entities and wrong for prose. On a structured
record a conflict is rare and the resolution is meaningful: two people set different values for
one field, and a human picks one. On a long note, two people typing in the same minute conflict
almost every time, and the resolution offered is "keep mine or keep theirs", which discards
someone's paragraph. That satisfies the letter of `PRD.md` s.80 — no silent overwrite — while
losing work just as effectively.

Single-writer avoids the conflict instead of resolving it badly: a second editor sees the note
as held, and can take over explicitly. Nothing is lost because nothing was concurrent.

`PRD.md` s.87 Test 5 — GM and assistant GM editing the same session note simultaneously — is
explicitly a Yjs test, and Yjs is V1 (`PRD.md` s.57, s.71). MVP is not expected to pass it. What
MVP must not do is pretend to handle it and quietly drop an edit.

### Applies to

Rich text on entities (16), session and GM notes (18), character long-text fields (15).
Not to structured fields, which keep optimistic concurrency and the version check.

### Consequences

- Feature 03 exposes a hold and takeover mechanism on long-text fields.
- Features 15, 16, 18 render "held by X" and a takeover action.
- V1 replaces this with Yjs and the mechanism is removed, not extended.

### Alternative if ratification goes the other way

If optimistic concurrency is chosen instead, every long-text edit must route through the shared
conflict surface (feature 03 FR-009) with both full versions available, and features must not
offer a bare "keep mine / keep theirs" choice on prose.

---

## Contract change process (FR-008)

After the freeze tag, a change to `packages/contracts` requires:

1. A dated note in this directory naming the reason, the affected features, and the migration.
2. Approval from one developer per track, within one working day.

The wave 0 spike already exercised this once, before the tag: it found that conflict detection
on an offline write is asynchronous, and `SyncedRepository` gained a `conflicts` channel as a
result (`spike-findings.md`, Finding 1). That is the process working, and it is why the spike
runs in wave 0 rather than wave 3.

---

## Product decisions

Ratified on 2026-08-27:

| Decision | Outcome |
| --- | --- |
| Cairn 2e and Fate Core licensing | Ship only official SRD-derived text/data under their applicable Creative Commons terms, with required attribution and share-alike compliance. Do not ship book artwork, layout, logos, or trademarks without separate permission. |
| Player-authored notes | Private to their author. GM roles cannot read them. |
| `observer` | Deferred beyond MVP. The contract value remains reserved for forward compatibility. |
| Player Session Mode and encounter view | Show session status, revealed scene information, the player's own character, visible party summaries, revealed handouts, public log entries, public participant identities/conditions, and the player's own state. Never send GM notes, hidden rolls, unrevealed entities, or enemy statistics. |
| Attachments | MVP accepts PDF, JPEG, PNG, and WebP, up to 25 MB per file. SVG is excluded. |
