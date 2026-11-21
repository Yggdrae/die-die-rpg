# BDD: Session Mode

Source: `_prd.md`, `PRD.md` s.5.4, s.43, s.44, s.45, s.76, s.78, s.79, s.88. P0 only.

## Lifecycle

### Scenario: A GM starts a session with the campaign in front of them

**Given** a GM role in a campaign with no open session  
**When** they start a session  
**Then** session N+1 is active at once on their device, with the party, the current scene, quick actions, GM notes,
and the log on one screen  
**And** the start is recorded (`session.started`) once the authority accepts it

### Scenario: Pause, resume, end

**Given** an active session  
**When** the GM pauses, resumes, then ends it  
**Then** its status follows `active -> paused -> active -> ended`, each change is in the log, and an ended session
can no longer change

### Scenario: One open session per campaign

**Given** an open session  
**Then** no second session can be started, on the device or at the authority (`session_already_open`)

### Scenario: Players cannot run a session

**Given** a player  
**Then** they see no session controls, and a crafted start, change, note, or log entry is refused with
`not_found_or_forbidden`

### Scenario: A stale change is a conflict

**Given** the GM and an assistant GM hold version 3 of a session  
**When** both change it  
**Then** the second is refused as a feature 03 conflict, nothing is overwritten silently, and the GM resolves it

## The GM screen

### Scenario: Party status at a glance (`PRD.md` s.44)

**Given** characters of the pinned system  
**Then** the party panel shows each one's declared summary values (`characterSchema.summaryFields`), never a value
chosen by system identity

### Scenario: The current scene with its location and NPCs

**Given** a scene entity `located_at` a location, and NPCs that `appear_in` it  
**When** the GM sets it as the current scene  
**Then** the screen shows the scene, the location, and the NPCs, and the change is logged and audited
(`session.scene_changed`)

### Scenario Outline: Quick actions without leaving the screen (`PRD.md` s.44)

**When** the GM invokes <action> on the session screen  
**Then** the owning feature's overlay opens over the session screen, and the screen is still there when it closes

| action |
| --- |
| Add NPC (feature 16) |
| Add note (feature 16) |
| Reveal handout (feature 17) |

### Scenario: An absent feature's quick action does not appear

**Given** no feature registers an encounter action  
**Then** no encounter action is shown, and nothing else changes

### Scenario: The command palette executes operations (`PRD.md` s.45)

**When** the GM presses `Ctrl + K`, types part of an operation or an entity name, and presses Enter  
**Then** the operation runs (a quick action, pause, end, set the scene, add a log note) or the entity is shown in the
lookup, without leaving the screen

### Scenario: An NPC from Session Mode in under 30 seconds and a reveal in under 5 (`PRD.md` s.78)

**When** the GM adds an NPC and reveals a handout from Session Mode  
**Then** the NPC is listed locally well under 30 seconds after the action starts, and the handout reaches the player's
screen within 5 seconds of the confirm

### Scenario: GM notes are GM-only and never lost silently

**When** the GM writes session notes  
**Then** no player device ever holds them  
**And** a save based on an older version is an explicit conflict, never a silent overwrite

### Scenario: The session log combines what happened

**Given** a roll, an effect application, a reveal, a scene change, and a GM log note during the session  
**Then** the log lists them in time order, each only on devices allowed to hold it

## Players

### Scenario: The player view is different data

**Given** an active session, a GM-only log note, a public log note, a hidden roll, and GM notes  
**Then** a player's device holds the session, the public note, and their own character, and never holds the GM notes,
the GM-only note, the hidden roll, or an unrevealed scene

### Scenario: A player sees what was revealed

**Given** the current scene is revealed to the player  
**Then** their session view shows it, with the revealed handouts and the public log

## Offline and performance

### Scenario: A whole session offline (`PRD.md` s.76)

**Given** the GM device is offline  
**When** they start a session, set the scene, write notes, log a note, and end it  
**Then** every change shows at once, waits in the queue, and is accepted once on reconnect

### Scenario: Cold offline open in under 2 seconds (`PRD.md` s.79)

**Given** a synchronized campaign and an open session, with the network down  
**When** the app is opened ten times from cold  
**Then** Session Mode is usable within 2 seconds at the 95th percentile

## Export

### Scenario: Sessions travel with the campaign

**When** a campaign is exported and imported  
**Then** its sessions, GM notes, and log entries are restored to the importer, and an unknown participant or scene is
dropped with a warning
