# PRD: Handouts and Reveal

Source: `PRD.md` s.31, s.34, s.35, s.37, s.68, s.76, s.78, s.87 Test 3, s.88.
Track: C. Depends on: visibility from feature 04, attachments from feature 05, entities from
feature 16.

## Problem

Revealing a handout is the most theatrical thing a tool can do for a table: a letter appears on
every player device at the moment the GM decides. `PRD.md` s.35 shows the whole flow, and s.78
sets the budget at under 5 seconds, because a reveal that takes longer kills the moment it exists
to create.

The correctness requirement is stronger than the timing one. `PRD.md` s.87 Test 3 requires that
revealing to player A gives player B nothing. If the handout was already synchronized to player B
device and only hidden in their interface, the reveal is theatre and the secret was never a secret.

## Goals

- A GM reveals prepared material to the table or to named players in under 5 seconds
  (`PRD.md` s.78).
- Unrevealed material is never present on an unauthorized device (`PRD.md` s.34, s.87 Test 3).
- A revealed handout is available offline for anyone who received it (`PRD.md` s.76).
- Preparing handouts before a session is fast enough that GMs actually do it.

## Non-Goals

- Attachment upload and storage. Feature 05 owns them.
- The visibility model. Feature 04 owns it; this feature is its most demanding consumer.
- Player-editable handouts and collaborative documents (`PRD.md` s.57 lists editable handouts under
  Yjs, V1).
- Knowledge and relationship reveals (`PRD.md` s.37), deferred with the knowledge graph.
- Realtime notification effects and animations (`PRD.md` s.56, V1). MVP reveals through the sync
  layer, which is the persistent path.
- Maps with fog of war or progressive reveal (`PRD.md` s.70).

## Users and Context

### Primary user

A GM at the moment of a reveal, with the table watching. They have one hand on a device and their
attention on the room, so the interaction must be one deliberate action with no confirmation maze
and no chance of revealing the wrong thing.

### Secondary users

Players receiving handouts, often on phones, sometimes offline.

## User Stories

- As a GM, I want to prepare handouts before a session and keep them hidden, so that I am ready
  without risking exposure.
- As a GM, I want to preview a handout before revealing it, so that I reveal the right one
  (`PRD.md` s.35).
- As a GM, I want to reveal to the whole table or to specific players, so that partial knowledge
  is possible (`PRD.md` s.34, s.37).
- As a GM, I want to see who currently has a handout, so that I know the table state
  (`PRD.md` s.35).
- As a player, I want a revealed handout to appear immediately, so that I am not asking whether
  I got it.
- As a player, I want a handout I received to open offline, so that the venue network does not
  matter.

## Functional Requirements

### P0 — MVP

- FR-001: Handout entity: title, body text, optional attachments (feature 05), visibility state,
  and audit fields. Built on the entity model from feature 16 rather than a parallel model.
- FR-002: Handout states per `PRD.md` s.35: hidden and revealed, with the recipient list visible
  to the GM when revealed.
- FR-003: Preview by the GM without revealing (`PRD.md` s.35).
- FR-004: Reveal to everyone, to a party, or to named players (`PRD.md` s.34), executed through
  feature 04.
- FR-005: A reveal is a single action from the GM view, completing in under 5 seconds end to end
  (`PRD.md` s.78).
- FR-006: Revealed handouts appear in a player view without a manual refresh, delivered through
  the sync layer (feature 03).
- FR-007: A hidden handout and its attachments are never synchronized to a device that may not
  see them (`PRD.md` s.34, s.87 Test 3). This is enforced in sync rules, not in rendering.
- FR-008: Revealed handouts are available offline to their recipients (`PRD.md` s.76), including
  attachment binaries where feature 05 pinning applies.
- FR-009: Every reveal emits an `AuditEvent` naming the actor, the handout, and the recipients
  (feature 06, `PRD.md` s.67).
- FR-010: Reveal available from Session Mode through the feature 18 quick action slot, without
  leaving the session screen (`PRD.md` s.44, s.45).
- FR-011: Un-reveal returns a handout to hidden for future synchronization, with the audit trail
  recording both actions. It does not remove what a player already read.
- FR-012: `ExportableModule` and `SearchIndexer` implementations for features 07 and 20.

### P1 — Important

- FR-101: Reveal scheduling or staging, so a GM prepares a reveal order before a session.
- FR-102: Read receipts showing which players opened a handout.
- FR-103: Reveal of a portion of a handout, for progressive disclosure of a long document.

### P2 — Later

- FR-201: Player-editable and collaborative handouts (`PRD.md` s.57, V1).
- FR-202: Knowledge and relationship reveal (`PRD.md` s.37, V1).
- FR-203: Realtime reveal notification with presence (`PRD.md` s.71).

## Behavioral Constraints

- A hidden handout must be absent from unauthorized devices, not hidden on them. Interface hiding
  is not a control, and once data is in a local database it is readable (`PRD.md` s.34).
- Reveal is additive and audited. Un-reveal does not un-know, and the interface must not imply
  that it does.
- The reveal action must be unambiguous about recipients before it executes, because revealing to
  the wrong player is not recoverable.
- Reveal must work offline for players who are already synchronized. A GM revealing offline queues
  the change; players receive it on reconnection.
- Attachment access follows the handout visibility. A revealed handout whose attachment is still
  restricted is a broken reveal, and the two must move together.

## Data and Privacy Considerations

- Handouts are the clearest case in the product where a data leak is a product failure rather than
  a security abstraction: a spoiled reveal cannot be undone.
- Recipient lists are campaign data visible to the GM and reveal who knows what.
- Handout content and attachments persist on recipient devices after the session and until
  membership ends (feature 03 FR-014).
- Export in feature 07 carries handouts with their visibility, including hidden ones.

## Success Signals

- `PRD.md` s.87 Test 3: reveal to player A delivers to player A and not to player B, verified in
  the sync payload and in the player local database, not only in the interface.
- `PRD.md` s.78: reveal completes in under 5 seconds, measured from GM action to player device.
- `PRD.md` s.88 acceptance: a player accesses revealed content.
- Zero hidden handouts present in any unauthorized local database across the validation campaign.

## Rollout

Wave 3, Track C. Depends on feature 04 from wave 2 for enforcement and feature 05 from wave 4 for
attachments, so text-only handouts ship first and attachment support follows. That ordering is
deliberate: the reveal correctness test in `PRD.md` s.87 Test 3 can pass with text alone and is
the property most worth proving early.

## Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Hidden handouts synchronized to player devices and hidden only in the interface | The secret was never secret, and no interface fix repairs it | Sync-rule enforcement (FR-007); explicit test asserting absence in the player local database, run in CI |
| Reveal to the wrong recipients | Unrecoverable spoiler mid-session | Explicit recipient confirmation in the action; preview before reveal (FR-003); audit trail |
| Attachment permissions lag behind handout reveal | A revealed handout shows a broken image at the dramatic moment | Handout and attachment visibility move together (FR-005 constraint); test with a pinned image |
| Reveal too slow over a poor venue network | The 5-second budget fails exactly when it matters | Small payload for text handouts; attachments pre-pinned by feature 05 before the session |
| Un-reveal presented as undo | GM believes information was retracted when players already read it | Interface language states what un-reveal does; audit records both actions (FR-011) |

## ADR Candidates

None specific. The enforcement decision belongs to feature 04, and this feature is its acceptance test.

## Open Questions

- TODO: Whether a handout is an entity type in feature 16 or its own model. Reuse is preferred and
  `PRD.md` s.31 lists handout as an attachment type, which suggests it may be neither.
- TODO: Whether un-reveal is in MVP scope. `PRD.md` s.35 shows reveal only.
- TODO: How a GM revealing while offline is presented to players who are online, given the GM
  device queues the change.
