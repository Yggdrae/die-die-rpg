# BDD: Dynamic Character Sheet

Source: `_prd.md`, `PRD.md` s.17, s.18, s.19, s.57, s.76, s.80, s.87 Test 2, s.88, s.89. P0 only.

## One Sheet, Any System

### Scenario Outline: The sheet comes from the pinned system's schema

**Given** a campaign pinned to <system>  
**When** a player opens their character  
**Then** every declared field appears in its group, with its declared component  
**And** no code named the system

| system |
| --- |
| the fixture system |
| Cairn 2e |
| Fate Core |

### Scenario: A component the sheet does not build degrades visibly

**Given** a field of a type no MVP package declares  
**Then** the sheet shows that the component is unavailable, names the field, and keeps working

## Creating and Owning

### Scenario: A member creates a character against the schema

**When** a player creates a character with a name  
**Then** it starts from the schema's defaults, belongs to them, and is pinned to the campaign's system

### Scenario Outline: Who may see and change a character

| actor | own character | another player's character |
| --- | --- | --- |
| a GM role | read and change | read and change |
| a player | read and change | neither, and absent from their device |
| a former member or a stranger | — | nothing |

### Scenario: A deleted character leaves the list and keeps its history

**When** its owner or a GM role deletes it  
**Then** it is a tombstone on every device that could read it

## Editing

### Scenario: A resource changes in one interaction, offline

**Given** a device with no connection  
**When** a player taps a resource down  
**Then** the sheet shows the new value at once  
**And** it reaches the authority once connected

### Scenario: Concurrent resource changes merge

**Given** a GM and a player changing the same resource offline, in opposite directions  
**When** both reconnect  
**Then** the resource holds both changes

### Scenario: Concurrent edits of one text never silently overwrite

**Given** two devices changing the same text field offline  
**When** both reconnect  
**Then** the first is kept, the second is refused, and its device reports it

### Scenario Outline: The schema bounds every value at the boundary

**When** a value <defect> is written  
**Then** it is refused before it is stored, on the device and at the authority

| defect |
| --- |
| outside a field's minimum or maximum |
| not among a select's values |
| of the wrong type for its field |
| for a field the schema does not declare |
| longer than the text limit |

### Scenario: Computed fields follow what they read

**When** a field a computed field reads changes  
**Then** the computed value updates with no other action

## GM-Only Fields

### Scenario: A GM-only field never reaches a player

**Given** a schema declaring a GM-only field  
**When** a GM writes it on a player's character  
**Then** the player's device holds neither the value nor the record of the change  
**And** a player cannot write it

## Acting From the Sheet

### Scenario: A player rolls a declared action from their sheet

**When** they pick what the action asks for and roll  
**Then** the roll is recorded, the plan is shown, and nothing changes until they apply it

### Scenario: An applied outcome changes the sheet

**When** a plan is applied  
**Then** the sheet shows the changes at once, through the same path as any edit

## Export and Search

### Scenario: Characters travel with the campaign

**When** a campaign is exported and imported  
**Then** each character returns with its state, owned by the importer, with GM-only values kept GM-only

### Scenario: A character is searchable by those who may read it

**Then** its search document carries its name and its Visibility

## Traceability

| PRD | Scenarios |
| --- | --- |
| FR-001, FR-002 | One Sheet, Any System |
| FR-003, FR-004, FR-012 | Creating and Owning |
| FR-005 | Who may see and change; GM-Only Fields |
| FR-006, FR-009, FR-010 | Editing |
| FR-007 | Computed fields |
| FR-008 | Acting From the Sheet |
| FR-011 | The schema bounds every value |
| FR-013 | Audit through `effect.applied` and `character.*` events (`_techspec.md`) |
| FR-014 | Export and Search |
