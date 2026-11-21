# BDD: Encounter Tracker

Source: `_prd.md`, `PRD.md` s.5.5, s.29, s.46, s.47, s.76, s.78, s.88, s.89. P0 only.

## Starting

### Scenario: A GM starts an encounter from Session Mode in seconds (`PRD.md` s.78)

**Given** an open session and a party of characters on the GM's device  
**When** the GM invokes "Add encounter", keeps the preselected party, types "Bandit" with a count of 3, and starts  
**Then** the tracker shows the party and Bandit 1, Bandit 2, and Bandit 3 over the session screen, well under 15
seconds after the action started  
**And** the encounter names the session it was started from

### Scenario: An absent encounter feature does not change Session Mode

**Given** the app shell registers no encounter action  
**Then** Session Mode shows no "Add encounter" action and nothing else changes (feature 18)

### Scenario: Players cannot run an encounter

**Given** a player  
**Then** they see no tracker controls, and a crafted encounter, participant, note, or effect on an instance is
refused with `not_found_or_forbidden`

## Participants

### Scenario: Three bandits are three participants (FR-003)

**Given** one creature entity "Bandit"  
**When** the GM adds it three times  
**Then** there are three participants with distinct labels and distinct state, and damage to one leaves the others
unchanged

### Scenario: An improvised enemy is a real entity (FR-002)

**When** the GM adds an ad hoc participant "Ogre" mid-encounter  
**Then** a feature 16 creature entity "Ogre" exists, GM-only, and the participant references it

### Scenario: A character participant is the character (write-through)

**Given** a character participant  
**When** the GM applies 2 damage from the tracker  
**Then** one feature 11 application targets the character itself, the sheet shows the same value, and no copy of the
character's state exists in the encounter

### Scenario: Removing a participant

**When** the GM removes a participant mid-encounter  
**Then** it leaves the tracker, and its character or entity is unchanged

## Display (`PRD.md` s.47, s.89)

### Scenario Outline: The same tracker renders each system from declarations

**Given** a campaign pinned to <system>  
**Then** each participant shows the package's `summaryFields` and its declared conditions, and its controls come from
the declared resource shapes, with no branch on the system's identity

| system |
| --- |
| fixture |
| Cairn 2e |
| Fate Core |

### Scenario: No turn order is imposed (`PRD.md` s.5.5)

**Then** the tracker shows no initiative, round, or turn control for a system that declares none

## Effects (FR-006, FR-007, FR-008)

### Scenario: Damage in one interaction

**When** the GM presses "-1" on a participant's pool resource  
**Then** exactly one feature 11 application is queued with a `delta` operation, never an absolute write, and the
participant shows the new value at once

### Scenario: A condition in one interaction

**When** the GM adds a declared condition to a participant, then removes it  
**Then** each is one feature 11 application, and the condition count follows

### Scenario: Concurrent damage merges

**Given** two GM devices offline  
**When** each applies 1 damage to the same bandit  
**Then** after both reconnect the bandit has taken 2 damage

### Scenario: An ended encounter is final

**Given** an ended encounter  
**Then** its participants, environment, and instance states can no longer change, on the device or at the authority

## Visibility (FR-013, `PRD.md` s.34)

### Scenario: Players never hold enemy statistics

**Given** a visible bandit with 3 of 5 hit points and the condition "Bleeding" (declared `everyone`)  
**Then** a player's replica holds the bandit's label and the "Bleeding" condition, and no hit points, no instance
state, and no GM notes

### Scenario: A hidden participant is absent from a player's replica

**Given** a participant drawn from a GM-only entity  
**Then** it starts hidden, and a player's replica does not hold it until the GM reveals it

### Scenario: A player sees their own character

**Given** a player's character in the encounter  
**Then** the player sees its summary and conditions; another player sees only its label

## Offline (`PRD.md` s.76)

### Scenario: A whole encounter offline

**Given** the GM's device loses its connection  
**When** they start an encounter, add participants, apply damage and conditions, and end it  
**Then** everything is shown at once, and after reconnecting it is accepted once, in order

## Audit and export (FR-014, FR-015)

### Scenario: Audited once

**Then** start, end, participant added, removed, and revealed are audited once each by the authority, even when a
mutation is resent, and every state change is feature 11's `effect.applied`

### Scenario: Exported with the campaign

**When** the campaign is exported and imported  
**Then** encounters, their GM notes, participants, and instance states are restored, with sessions, locations,
characters, and entities mapped, and a participant whose source was not restored is dropped with a warning
