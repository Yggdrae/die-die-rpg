# BDD: Handouts and Reveal

Source: `_prd.md`, `PRD.md` s.34, s.35, s.67, s.76, s.78, s.87 Test 3, s.88. P0 only.

## Preparing

### Scenario: A GM prepares a handout that stays hidden

**Given** a GM role in a campaign  
**When** they create a handout with a title, a body, and an image  
**Then** it is hidden: no player device receives it, its body, or its image

### Scenario: A GM previews before revealing

**When** a GM opens a hidden handout's preview  
**Then** they see it as a recipient will (title, body, attachments) and nothing changes for anyone

### Scenario: Players cannot prepare or reveal

**Given** a player  
**Then** they see no handout controls, and a crafted reveal is refused with `not_found_or_forbidden`

## Revealing

### Scenario Outline: Reveal to the right people only (`PRD.md` s.87 Test 3)

**Given** a hidden handout and players A and B  
**When** the GM reveals it to <audience>  
**Then** <received> receive it through sync, without a refresh  
**And** <absent> never hold the row, in the sync payload or in the local database

| audience | received | absent |
| --- | --- | --- |
| player A | player A | player B |
| everyone | players A and B | nobody |

### Scenario: The recipients are explicit before the reveal executes

**When** a GM chooses recipients  
**Then** the confirm action names them ("Reveal to Ana", "Reveal to everyone")  
**And** nothing is revealed until that one action

### Scenario: A reveal reaches the player in under 5 seconds (`PRD.md` s.78)

**When** a GM confirms a reveal online  
**Then** the handout appears on the recipient's screen within 5 seconds

### Scenario: The reveal is what the GM previewed

**Given** a GM previewed version 3 of a handout  
**When** another GM edits it to version 4 before the reveal is applied  
**Then** the reveal is refused as a conflict, nothing is revealed, and the GM can review and reveal again

### Scenario: Attachments move with the handout

**Given** a hidden handout with an image  
**When** it is revealed to player A  
**Then** player A can open the image, and player B still cannot

### Scenario: The GM sees who has a handout

**Then** each handout shows hidden, or the names of its recipients, or everyone

### Scenario: Every reveal and un-reveal is audited

**Then** one audit event names the actor, the handout, and the recipients, even when the upload is retried

## Offline

### Scenario: A GM reveals while offline

**Given** the GM device is offline  
**When** the GM reveals a handout  
**Then** the GM sees it waiting to be sent, and players see nothing yet  
**And** recipients receive it once the GM device reconnects, exactly once

### Scenario: A received handout opens offline

**Given** player A received a handout  
**When** their device is offline  
**Then** the handout opens from the local replica

## Un-reveal

### Scenario: Un-reveal hides from now on, and says so

**When** a GM hides a revealed handout again  
**Then** it leaves the players' devices on their next sync  
**And** the screen states that anyone who already read it keeps what they read

## Session Mode

### Scenario: Reveal from the session screen

**Then** a session quick action "Reveal handout" opens the same reveal overlay
