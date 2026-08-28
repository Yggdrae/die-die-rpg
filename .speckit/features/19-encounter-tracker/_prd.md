# PRD: Encounter Tracker

Source: `PRD.md` s.5.5, s.29, s.46, s.47, s.68, s.76, s.78, s.88, s.89.
Track: C. Depends on: entities from feature 16, characters from feature 15, action and effect
execution from feature 11, capability declarations from feature 08.

## Problem

`PRD.md` s.47 sets a requirement most tools fail: the tracker adapts to the system. A resource
system shows hit protection and armour, a narrative system shows stress and consequences, a d20
system shows hit points, defence, and conditions. Those are not three configurations of an
initiative list; they are three different things the same screen must be.

The second constraint is cultural. `PRD.md` s.5.5 requires the platform to support narrative and
rules-light systems without forcing a virtual tabletop or tactical combat paradigm. A tracker
built around initiative order and turns would quietly make Fate feel wrong, which is the failure
mode that does not show up in a test suite.

## Goals

- A GM starts an encounter in under 15 seconds (`PRD.md` s.78).
- The tracker renders any conforming system from capability declarations, with no system branch
  (`PRD.md` s.47, s.89).
- Applying an outcome to a participant is one interaction, executed through feature 11.
- The tracker does not impose turn order on systems that do not have one (`PRD.md` s.5.5).

## Non-Goals

- Grid, tokens, movement, lighting, maps (`PRD.md` s.70).
- Automated turn resolution or artificial intelligence for enemies.
- Initiative systems for systems that do not declare one. MVP neither system requires a
  turn order, so building one is speculative.
- Creature statistics blocks. Feature 16 owns creature entities.
- Action and effect logic. Feature 11 owns it.
- Encounter design or balancing tools.

## Users and Context

### Primary user

The GM, mid-encounter, tracking several participants while narrating. The encounter is the moment
with the most state changes per minute in the product, and the moment a GM is least able to
navigate.

### Secondary users

Players, who see the encounter state their permissions allow, typically the participants and their
own condition rather than enemy statistics.

## User Stories

- As a GM, I want to start an encounter from the session screen in seconds, so that a fight does
  not begin with data entry (`PRD.md` s.78).
- As a GM, I want to add the party and a few enemies quickly, so that setup is not a form.
- As a GM, I want each participant to show the values my system cares about, so that the tracker
  is useful rather than generic.
- As a GM, I want to apply damage or a condition in one interaction, so that the encounter moves.
- As a GM, I want to add an unplanned enemy mid-encounter, so that improvisation is supported.
- As a GM, I want the encounter to survive a connection drop, so that a dead spot does not cost
  me the state (`PRD.md` s.76).

## Functional Requirements

### P0 — MVP

- FR-001: Encounter model per `PRD.md` s.46: participants, environment, conditions, system state,
  notes.
- FR-002: Participants drawn from existing characters (feature 15) and entities (feature 16),
  plus ad hoc participants created inline for improvisation.
- FR-003: Multiple instances of one creature as distinct participants with distinct state, since
  three bandits are three participants (`PRD.md` s.46).
- FR-004: Participant display driven by capability declarations from the pinned system
  (`PRD.md` s.47). The tracker asks the system which values summarize a participant; it never
  names them itself.
- FR-005: Start an encounter in under 15 seconds including participant selection (`PRD.md` s.78),
  launched from the Session Mode quick action slot (feature 18 FR-008).
- FR-006: Apply an action or effect to a participant through feature 11, in one interaction, with
  the result reflected on the participant and on the underlying character or entity.
- FR-007: Resource changes on participants emit `SemanticOp` deltas (`PRD.md` s.57), never
  absolute writes.
- FR-008: Conditions applied and removed on participants, using the feature 11 condition effects.
- FR-009: Environment notes per `PRD.md` s.46, for example location and lighting, as free text
  linked to a location entity where one exists.
- FR-010: Add and remove participants mid-encounter.
- FR-011: End an encounter, retaining it in the session record (feature 18 FR-003).
- FR-012: Full offline operation (`PRD.md` s.76).
- FR-013: Player view scoped by feature 04. It shows public participant identities and conditions
  plus the player's own state, but never enemy statistics or hidden participants.
- FR-014: Audit events for participant state changes (feature 06).
- FR-015: `ExportableModule` implementation for feature 07.

### P1 — Important

- FR-101: Turn order and round tracking, for systems that declare a turn-based capability. Built
  when a system that needs it exists, not before (`PRD.md` s.11, s.12).
- FR-102: Encounter templates, so a prepared encounter starts pre-populated.
- FR-103: Group actions applied to several participants at once.

### P2 — Later

- FR-201: Three-action economy and complex condition support for Pathfinder-style systems
  (`PRD.md` s.12).
- FR-202: Encounter difficulty estimation.

## Behavioral Constraints

- No branch on system identity (`PRD.md` s.89). Participant summaries come from capability
  declarations, exactly as the party panel in feature 18 FR-005 does.
- No turn order is imposed. Neither MVP system requires one, and adding it by default would push
  narrative systems toward a tactical paradigm that `PRD.md` s.5.5 rejects.
- Participant state changes write through to the underlying character or entity. An encounter is
  a view over live state, not a copy, because a copy means a GM reconciles two versions of a
  player hit points after the fight.
- Ad hoc participants created inline are real entities, so an improvised enemy that matters can be
  kept rather than retyped.
- Applying an effect goes through feature 11. The tracker does not compute damage, because two
  implementations of damage is how the two features drift apart.
- Fully operational offline. An encounter is the least acceptable moment for a network dependency.

## Data and Privacy Considerations

- Enemy statistics are GM-only by default. A tracker that reveals a creature remaining hit points
  to players changes the game (`PRD.md` s.34).
- Participant state is live character and entity state, so encounter visibility must agree with
  the visibility of the underlying record rather than being decided separately.
- Encounter records are part of the session and are exported with the campaign.

## Success Signals

- `PRD.md` s.78: an encounter started in under 15 seconds, measured mid-session.
- `PRD.md` s.47 and s.89: the same tracker renders a Cairn encounter and a Fate conflict with no
  system branch, verified by the architecture guard in feature 00 FR-009.
- `PRD.md` s.88 acceptance: the GM manages an encounter.
- A GM runs a full combat without opening the character sheets of the participants.
- Zero enemy statistics present in a player local database where the underlying entity is GM-only.

## Rollout

Wave 4, Track C, after Session Mode provides the entry point and after features 11, 15, and 16
provide participants and effects. Until then it builds against fixture participants from feature 00.
Real validation requires a live table, since the 15-second budget and the one-interaction
requirement are only meaningful under the pressure of an actual encounter (`PRD.md` s.81).

## Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Tracker built around initiative and turns | Narrative systems feel wrong, contradicting `PRD.md` s.5.5, and the failure is invisible to tests | No turn order in MVP (FR-101 deferred until a system declares it); validated with a Fate table |
| System-specific participant summaries | Most likely place after feature 15 to break `PRD.md` s.89 | Capability-declared summaries (FR-004), shared mechanism with feature 18 FR-005 |
| Encounter state copied instead of referenced | GM reconciles two versions of player state after every fight | Write-through to live character and entity state (behavioural constraint) |
| Damage computed locally instead of through feature 11 | Two implementations of the same rule, drifting silently | All state change through feature 11 (FR-006); review gate on direct resource writes |
| Setup too slow | GMs track encounters on paper, and the feature is dead on arrival | 15-second budget with inline ad hoc participants (FR-002, FR-005), measured in a real session |
| Enemy statistics leak to players | The game changes and the GM loses tension they cannot recover | Underlying entity visibility governs (feature 04); explicit test |

## ADR Candidates

None specific. Capability-driven rendering is decided in feature 08, and this feature is one of
its two acceptance tests alongside feature 15.

## Open Questions

- TODO: Whether encounter participants are references to characters and entities or lightweight
  copies with a link. The write-through constraint favours references; ad hoc participants may
  need a different shape.
- The MVP player encounter view is defined by FR-013.
- TODO: Whether the condition model from the feature 11 open question is sufficient for tracker
  display, or whether conditions need duration to be useful here.
- TODO: How multiple instances of one creature are named and distinguished in the interface.
