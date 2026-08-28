# PRD: Session Mode

Source: `PRD.md` s.5.4, s.43, s.44, s.45, s.68, s.76, s.78, s.79, s.88.
Track: C. Depends on: campaign context from feature 02, entity API from feature 16, action
execution from feature 11, quick action slot contract from feature 00.

## Problem

`PRD.md` s.5.4 states the product principle: the GM is the primary user and in-session flows must
require the minimum possible navigation. Every other screen in the product can afford a click;
this one cannot, because the GM is talking to five people while using it.

Section 43 makes the structural point that a campaign and a session are different things. A
session has participants, a start and an end, a current scene, and a record of what happened.
Without it, a campaign is a static wiki and the product is a preparation tool rather than the
session operating system described in `PRD.md` s.1.

## Goals

- A GM runs a whole session from one screen, reaching common operations without navigating away
  (`PRD.md` s.44, s.45).
- A session records what happened, so the next session starts informed (`PRD.md` s.43).
- Session Mode is usable within p95 under 2 seconds from a cold offline open (`PRD.md` s.79).
- Features contribute quick actions without this feature knowing what they are.

## Non-Goals

- Virtual tabletop features: maps, tokens, grids, lighting (`PRD.md` s.40 is not a VTT, s.70).
- Voice and video (`PRD.md` s.70).
- Presence, cursors, typing indicators (`PRD.md` s.56, V1).
- Clocks, events, timeline in the session view (`PRD.md` s.71, V1), though the quick action slot
  must accommodate them without a redesign.
- Encounter mechanics. Feature 19 owns them and contributes to this screen.
- Collaborative session notes. Yjs is V1 (`PRD.md` s.57); MVP notes are single-writer.

## Users and Context

### Primary user

The GM, running a session, with divided attention, often standing, often with a rulebook or a
drink in the way. They will use this screen for three continuous hours and will abandon it for
paper the first time it costs them the room.

### Secondary users

Players, who see a session view scoped to what they may see. An assistant GM, who shares the GM
view subject to feature 04.

## User Stories

- As a GM, I want to start a session and have the campaign context in front of me, so that I am
  not opening five screens before play begins.
- As a GM, I want party status visible at a glance, so that I know who is hurt without asking
  (`PRD.md` s.44).
- As a GM, I want the current scene, its location, and its NPCs in view, so that I am not
  searching for what I prepared.
- As a GM, I want to create an NPC, a note, or a reveal without leaving this screen, so that
  improvisation costs seconds (`PRD.md` s.44, s.45).
- As a GM, I want a command palette, so that a common operation is a few keystrokes
  (`PRD.md` s.45).
- As a GM, I want the session to survive a network drop, so that a dead spot is not an interruption
  (`PRD.md` s.76).
- As a GM, I want to end a session and keep a record, so that preparing the next one starts from
  what happened.

## Functional Requirements

### P0 — MVP

- FR-001: Session entity distinct from campaign (`PRD.md` s.43), with number, participants,
  start and end times, current scene, and status.
- FR-002: Start, pause, resume, and end a session.
- FR-003: Session record per `PRD.md` s.43: participants, timing, current scene, rolls, events,
  encounters, notes, reveals, resource changes.
- FR-004: GM session screen with the regions in `PRD.md` s.44: party status, current scene with
  location and NPCs, quick actions, GM notes.
- FR-005: Party panel showing each character with the resources their system declares as summary
  values. Driven by capability declarations, never by system identity (`PRD.md` s.47, s.89).
- FR-006: Current scene selection, linked to a location and the NPCs present, resolved through
  feature 16.
- FR-007: GM notes for the session, single-writer in MVP, private to GM roles by default.
- FR-008: Quick actions per `PRD.md` s.44, contributed through the `SessionQuickAction` slot from
  feature 00: add NPC (16), add encounter (19), add note (16), reveal (17). Clock (V1) registers
  later with no change here. An action whose feature is absent simply does not appear.
- FR-009: Command palette on `Ctrl + K` per `PRD.md` s.45, searching entities, actions, and rules
  through the feature 20 search contract, and executing common operations without leaving the screen.
- FR-010: Session log combining rolls, effect applications, reveals, and notes in chronological
  order, scoped by visibility.
- FR-011: Full offline operation: start, run, and end a session with no network (`PRD.md` s.76).
- FR-012: Player session view showing session status, revealed scene information, the player's
  own character, visible party summaries, revealed handouts, public log entries, public encounter
  participant identities and conditions, and the player's own encounter state. It never includes
  GM notes, hidden rolls, unrevealed entities, or enemy statistics.
- FR-013: Audit events for session start, end, and scene change (feature 06).
- FR-014: `ExportableModule` implementation for feature 07.
- FR-015: Cold open to usable Session Mode within p95 under 2 seconds, offline, warm local
  database, typical campaign (`PRD.md` s.79).

### P1 — Important

- FR-101: Session preparation view: a checklist of what is ready before a session starts.
- FR-102: Session recap generated from the previous session log.
- FR-103: Rules panel inside Session Mode (feature 14 FR-102), so a lookup does not leave the screen.

### P2 — Later

- FR-201: Clocks, events, and timeline in the session view (`PRD.md` s.71).
- FR-202: Presence and player-joined indicators (`PRD.md` s.56).
- FR-203: Collaborative session notes (`PRD.md` s.57).

## Behavioral Constraints

- Minimum navigation is the design constraint, not a preference (`PRD.md` s.5.4). Any operation
  in the quick action set that requires leaving the screen has failed.
- No branch on system identity. The party panel renders from capability declarations
  (`PRD.md` s.47, s.89).
- Quick actions and palette entries are registered by their owning features. This feature must not
  import feature 16, 17, or 19 internals, because that would make the session screen depend on
  three features and block Track C on itself.
- The session must remain fully operational offline. A network-dependent element on this screen
  contradicts the reason the product is local-first (`PRD.md` s.5.3).
- The GM view and the player view are different data, not the same data styled differently
  (feature 04). GM notes must not reach player devices.
- The p95 under 2 seconds budget in `PRD.md` s.79 is measured on this screen specifically, which
  makes it the performance contract for the local database.

## Data and Privacy Considerations

- GM session notes are private to GM roles and must not synchronize to player devices
  (`PRD.md` s.34).
- The session log contains rolls with visibility, including hidden GM rolls, which must be
  filtered at the sync boundary rather than at render (feature 09 FR-008).
- Participant records show who was present, which is campaign data.
- Session records are exported with the campaign in feature 07.

## Success Signals

- `PRD.md` s.79: p95 under 2 seconds from cold offline open to usable Session Mode.
- `PRD.md` s.78: NPC created in under 30 seconds and handout revealed in under 5 seconds, both
  measured from within Session Mode rather than from their own screens.
- `PRD.md` s.88 acceptance: the GM starts a session, executes actions, rolls dice, and manages an encounter.
- A GM runs a full validation session without opening another application or a paper notebook,
  which is the real test of `PRD.md` s.2.
- Adding a quick action from a new feature requires no change in this feature.

## Rollout

Wave 3, Track C, after entities so the quick actions have something to create. Encounter and
handout actions register as features 19 and 17 land; the screen ships useful with fewer actions
and gains them without redesign. Validation sessions with real players (`PRD.md` s.81) should
begin as soon as this screen is usable, because its failure modes are behavioural and will not
appear in a demo.

## Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| The screen imports feature 16, 17, 19 internals for quick actions | Track C blocks on itself and the split fails inside one track | `SessionQuickAction` slot contract from feature 00 (FR-008); architecture guard from feature 00 FR-009 |
| Cold start misses the 2-second budget | The central offline performance promise in `PRD.md` s.79 fails on the screen it was written for | Measure from wave 3 onward on a phone-class device; local database size budget agreed with feature 03 |
| The screen accumulates every feature until it is unusable | The GM abandons it, which is the one failure the product cannot survive | Regions fixed by `PRD.md` s.44; new capability arrives through quick actions and the palette, not new panels |
| Party panel needs system-specific summaries | The most visible violation of `PRD.md` s.89 | Capability-declared summary values (FR-005), same mechanism as feature 19 |
| GM notes leak to players | Preparation and hidden intent exposed mid-session | GM-only by default, enforced in sync rules (feature 04) |
| Command palette built as a search box only | The stated goal in `PRD.md` s.45, executing operations without leaving the screen, is not met | Palette executes registered operations, not only navigation (FR-009) |

## ADR Candidates

- Slot-based contribution for quick actions and palette operations, versus the session screen
  importing each feature. The alternative is the natural way to build it and would create the only
  intra-track dependency chain in the plan.

## Open Questions

- TODO: Whether scenes are owned by this feature or by feature 16, shared with the feature 16 open
  question. `PRD.md` s.29 lists scenes as campaign content; s.44 shows a current scene in session.
- TODO: Whether the session log is a view over the audit log (feature 06), a separate store, or
  both. Affects volume, retention, and the `PRD.md` s.79 budget.
- The MVP player view is defined by FR-012 and enforced as distinct synchronized data, not a
  client-side filter over the GM view.
- TODO: Whether an assistant GM shares the GM view entirely, given `PRD.md` s.87 Tests 5 and 6
  assume they edit the same session note.
