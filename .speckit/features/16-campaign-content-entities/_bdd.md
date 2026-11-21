# BDD: Campaign Content and Entities

Source: `_prd.md`, `../_index.md` (product decisions made during wave 0),
`packages/contracts/src/{entity,visibility,actor,registries,attachment,audit}.ts`,
`../04-visibility-and-authorization/_bdd.md`, `../03-offline-sync-platform/_bdd.md`,
`../06-audit-log/_bdd.md`.

Settled facts these scenarios assume rather than re-decide:

- Every entity is an `EntityEnvelope` (`id`, `campaignId`, `type`, `name`, `tags`, `metadata`,
  `visibility`, `version`, `createdAt/By`, `updatedAt/By`, optional `deletedAt`). Visibility is
  required and is the frozen `gm_only | everyone | party | players` union.
- Feature 04 decides access and filters sync. Party targeting fails closed in P0, so no scenario
  below expects a `party` grant to work.
- Player-authored notes are private to their author. GM roles cannot read them
  (`../_index.md`, wave 0 decision; PRD open-questions line 1).
- `observer` has no MVP capabilities.

"Local database" means the device replica from feature 03. "Entity" means one record of any
configured type. "Personal note" means a player-authored private note. Scenarios tagged
`[D-NN]` trace to a product decision recorded in `_techspec.md` "Decisions" (decided
2026-10-28, delegated by the owner); their expected outcome is the decided one.

---

## Behavioral Overview

A GM creates, edits, links, tags, hides, reveals, and soft-deletes campaign content of several
types through one model. Creation from scratch must fit inside 30 seconds mid-session, so quick
create asks for a name and at most one more field. Everything works offline and synchronizes
later. The behavioral risk that dominates is exposure: GM-only content, links between hidden
entities, or another player's private notes reaching a player device.

## Behavioral Scope

### In Scope

- Entity CRUD with soft delete for the MVP types: NPC, creature, location, item, faction, note,
  scene `[D-02]`.
- Free-form custom fields `[D-01]`.
- Type as configuration; quick create; rich-text description with a single writer.
- Tags with suggestions; listing and filtering by type, tag, and visibility.
- Typed relationships with their own visibility; broken links after delete.
- Personal notes for players, without attachments or relationships `[D-15]`.
- Default `gm_only`, reveal and un-reveal through feature 04.
- Offline create/read/update/delete, deferred conflicts through the feature 03 surface.
- Audit events, export and search contributions, a module API for features 17, 18, 19.

### Out of Scope

- Clues, secrets, quests, events, clocks, timeline (FR-201), graph visualization (FR-202),
  collaborative text (FR-203).
- Creature statistics (FR-101, P1), bulk operations (FR-102), templates (FR-103), relationship
  browsing view (FR-104).
- Attachment upload, storage, and rendering. Feature 05 owns them; this feature only offers them
  on an entity.
- Placing the quick actions on the Session Mode screen (feature 18) `[D-14]`.
- Markdown rendering of descriptions (P0 shows the source as plain text) `[D-10]`.
- Character sheets (feature 15). Handout reveal flow (feature 17).

## Business Rules

- BR-001: One record model serves every type. A type differs only by its configuration.
- BR-002: An entity created by a GM role with no visibility supplied is `gm_only`.
- BR-003: Quick create requires a name. Type comes from the entry point; visibility defaults;
  nothing else is required before saving.
- BR-004: Delete is a soft delete. The record keeps its identity as a tombstone; relationships to
  it remain and render as broken.
- BR-005: A relationship has its own visibility, defaulting to `gm_only`.
- BR-006: A relationship is never visible to an actor who may not read both of its endpoints;
  narrowing an endpoint narrows its relationships `[D-07]`.
- BR-007: A personal note is readable and writable by its author only, GM roles included. Only
  players write personal notes `[D-06]`.
- BR-008: The description of an entity has at most one writer at a time.
- BR-009: Tags are free-form, campaign-scoped, normalized to lowercase `[D-18]`, and suggested from
  tags the actor can already see.
- BR-010: Every accepted create, update, delete, and visibility change produces one audit event.
- BR-011: Every structured edit is versioned; a stale edit is a conflict, never a silent overwrite.

## Scenarios

### Creating

#### Scenario: A GM captures an NPC with a name and one line

**Given** a GM is in campaign A  
**When** the GM quick-creates an NPC with name "Ferryman" and the line "Asks for silver, takes copper"  
**Then** an entity of type `npc` named "Ferryman" with that line exists in campaign A  
**And** its visibility is `gm_only`  
**And** its version is 1 and `createdBy` is the GM

#### Scenario: Quick create asks for nothing but a name

**Given** a GM opens quick create from the "Add NPC" entry point  
**When** the GM types a name and saves without touching any other control  
**Then** the entity is saved  
**And** no type, visibility, location, tag, or relationship choice was required

#### Scenario: Quick create without an entry-point type `[D-09]`

**Given** a GM opens quick create from a generic entry point that implies no type  
**When** the GM types a name and saves  
**Then** the entity is saved with type `note`, the default quick-create type  
**And** the type can be changed afterwards

#### Scenario: A name is required

**Given** a GM is creating an entity  
**When** the GM saves with an empty or whitespace-only name  
**Then** nothing is stored  
**And** the form reports that a name is required

#### Scenario: An unknown type is rejected

**Given** the type configuration contains no type `villain`  
**When** a create for type `villain` reaches the authority  
**Then** the create is rejected  
**And** no record is stored

#### Scenario: An explicit visibility at create is kept

**Given** a GM creates a location and chooses visibility `everyone`  
**When** the create is accepted  
**Then** the stored visibility is `everyone`

#### Scenario Outline: Who may create campaign entities `[D-04, D-05]`

**Given** an actor with role `<role>` in campaign A  
**When** the actor creates an entity in campaign A  
**Then** the create is `<outcome>`

| role | outcome |
| --- | --- |
| owner | accepted |
| gm | accepted |
| assistant_gm | accepted |
| player | rejected |
| observer | rejected |

### Type as Configuration

#### Scenario: Every MVP type uses the same screens

**Given** the MVP types are configured  
**When** a GM creates, edits, lists, and deletes one entity of each type  
**Then** every type goes through the same list, detail, and editor  
**And** only labels and configured field presence differ

#### Scenario: A new type needs configuration only

**Given** a type `vehicle` is added to the type configuration  
**And** no screen, route, table, or sync rule is added or changed  
**When** a GM creates, lists, filters, reveals, and deletes a `vehicle`  
**Then** every operation succeeds  
**And** the `vehicle` follows the same visibility and sync rules as every other type

#### Scenario: A type removed from configuration does not lose data

**Given** entities of type `vehicle` exist  
**When** `vehicle` is removed from the configuration  
**Then** existing `vehicle` entities remain readable and deletable  
**And** new `vehicle` entities cannot be created

### Reading, Listing, and Filtering

#### Scenario Outline: Filtering narrows the permitted set

**Given** campaign A contains entities of several types, tags, and visibilities  
**When** a GM lists entities filtered by `<filter>`  
**Then** exactly the entities matching `<filter>` are returned  
**And** the total equals the number returned across pages

| filter |
| --- |
| type `npc` |
| tag `antagonist` |
| visibility `gm_only` |
| type `location` and tag `site` |

#### Scenario: A player's list contains only what the player may see

**Given** campaign A has 6 NPCs, of which 4 are `everyone` and 2 are `gm_only`  
**When** player Casey lists NPCs  
**Then** 4 NPCs are returned and the total is 4  
**And** no placeholder represents the other 2

#### Scenario: A hidden entity and a missing entity look the same

**Given** entity X in campaign A is `gm_only` and identifier Y does not exist  
**When** player Casey requests X and then Y  
**Then** both responses are the same `not_found_or_forbidden` error with the same status and body

#### Scenario: Filtering by visibility does not reveal hidden content to players

**Given** campaign A has `gm_only` entities  
**When** player Casey lists entities filtered by visibility `gm_only`  
**Then** the result is empty and the total is 0

#### Scenario: A GM finds an entity by a name fragment

**Given** campaign A contains an NPC named "Bandit Leader"  
**When** a GM searches entities for "bandit"  
**Then** "Bandit Leader" is among the results  
**And** the search works with no network

### Editing

#### Scenario: A structured edit increments the version

**Given** an entity at version 3  
**When** a GM renames it based on version 3  
**Then** the stored name changes and the version is 4  
**And** `updatedBy` is the GM

#### Scenario: A stale structured edit is a conflict

**Given** two GM roles hold the same entity at version 3  
**And** each renames it based on version 3  
**When** both edits reach the authority  
**Then** exactly one is accepted  
**And** the other is reported as a conflict carrying both values  
**And** the rejected value is not applied without the author choosing to resubmit it

#### Scenario: A deferred conflict surfaces after an offline edit

**Given** a GM edits an entity summary offline based on version 3  
**And** another GM's edit of the same entity was accepted as version 4  
**When** the first GM's device reconnects  
**Then** the shared conflict surface shows the entity with the local and authoritative values  
**And** the local value is not silently replaced  
**And** the GM can keep the authoritative value or resubmit theirs against version 4

### Rich-Text Description

#### Scenario: Only one writer edits a description

**Given** GM Avery is editing the description of entity X  
**When** GM Blake opens the description of X for editing  
**Then** Blake sees that Avery is editing  
**And** Blake cannot save a description change while Avery's hold is active

#### Scenario: Takeover ends the previous writer's authority without losing text

**Given** GM Avery holds the description of entity X with unsaved text  
**When** GM Blake explicitly takes over  
**Then** Blake may save description changes  
**And** Avery is notified and can no longer save  
**And** Avery's unsaved text remains on Avery's device

#### Scenario: A description save without a current hold is rejected

**Given** a description change was recorded under a hold that has since expired or been taken over  
**When** the change reaches the authority  
**Then** the change is rejected  
**And** the stored description is unchanged

#### Scenario: A player never learns who is editing hidden content

**Given** GM Avery holds the description of a `gm_only` entity  
**When** player Casey's device synchronizes  
**Then** no hold for that entity reaches Casey's local database

### Tags

#### Scenario: Tags are normalized `[D-18]`

**Given** a GM tags an entity with " Antagonist ", "antagonist", and "Village"  
**When** the change is saved  
**Then** the entity carries exactly the tags `antagonist` and `village`  
**And** tags longer than 64 characters are rejected

#### Scenario: Suggestions come from tags the actor can see

**Given** tag `secret-cult` appears only on `gm_only` entities  
**And** tag `village` appears on an `everyone` entity  
**When** player Casey asks for tag suggestions starting with "s" or "v"  
**Then** `village` may be suggested  
**And** `secret-cult` is never suggested

### Custom Fields

#### Scenario: A GM adds a free-form custom field `[D-01]`

**Given** a GM edits NPC "Ferryman"  
**When** the GM adds the field "Price" with value "one silver" and saves  
**Then** "Ferryman" shows the field "Price" with value "one silver"  
**And** no type configuration or screen change was needed  
**And** a second field labelled "price" on the same entity is rejected

### Relationships

#### Scenario: A GM links an NPC to a faction and a location

**Given** NPC "Smuggler", faction "River Guild", and location "Abandoned Warehouse" exist  
**When** the GM links Smuggler "member of" River Guild and Smuggler "lives at" the warehouse  
**Then** Smuggler shows both links  
**And** River Guild shows Smuggler as a member  
**And** the warehouse shows Smuggler as a resident

#### Scenario: A new relationship is GM-only

**Given** two `everyone` NPCs  
**When** a GM links them without choosing a visibility  
**Then** the relationship is `gm_only`  
**And** players see both NPCs but not the link

#### Scenario: A relationship is revealed on its own

**Given** two `everyone` NPCs linked by a `gm_only` relationship  
**When** the GM reveals the relationship to everyone  
**Then** players see the link  
**And** the NPCs' own visibility is unchanged

#### Scenario: A relationship cannot outrun its endpoints `[D-07]`

**Given** NPC "Merchant" is `everyone` and NPC "Smuggler" is `gm_only`  
**And** they are linked by a `gm_only` relationship  
**When** a GM tries to reveal the relationship to everyone  
**Then** the change is rejected with a validation reason  
**And** the relationship stays `gm_only`

#### Scenario: Hiding an endpoint hides its relationships `[D-07]`

**Given** NPC "Traveler" and location "Old Road" are `everyone`  
**And** their "lives at" relationship is `everyone`  
**When** the GM changes Traveler to `gm_only`  
**Then** the relationship is no longer visible to players  
**And** the relationship's narrowing is audited  
**And** no player local database holds the relationship after the next synchronization

#### Scenario: A link to a hidden entity does not disclose its identifier

**Given** a relationship whose target is `gm_only`  
**When** player Casey's device synchronizes  
**Then** neither the relationship nor the target identifier reaches Casey's local database

#### Scenario: Duplicate and self links are refused

**Given** NPC A is already linked "knows" NPC B  
**When** a GM links A "knows" B again, or links A "knows" A  
**Then** the duplicate and the self-link are rejected

#### Scenario: Relationship kinds come from configuration `[D-08]`

**Given** the configured relationship kinds `member_of`, `lives_at`, `located_at`, `knows`, `owns`,
`appears_in`, `related_to`  
**When** a GM creates a relationship with a kind that is not configured  
**Then** the relationship is rejected

### Deletion

#### Scenario: Delete is a soft delete

**Given** an NPC at version 2  
**When** a GM deletes it based on version 2  
**Then** it no longer appears in lists  
**And** it is stored as a tombstone with `deletedAt` set and version 3

#### Scenario: Relationships survive as broken links

**Given** NPC "Guard" is linked "lives at" location "Village"  
**When** the GM deletes "Guard"  
**Then** "Village" still lists the relationship  
**And** the relationship renders as a link to a deleted entity  
**And** no relationship is deleted by the cascade

#### Scenario: A deleted entity cannot be edited

**Given** an entity is a tombstone  
**When** an update for it reaches the authority  
**Then** the update is rejected  
**And** the tombstone is unchanged

#### Scenario: Deleting hidden content leaves no trace on a player device

**Given** a `gm_only` entity that never reached player Casey  
**When** a GM deletes it  
**Then** no tombstone for it reaches Casey's local database

### Visibility

#### Scenario: Reveal and un-reveal go through feature 04

**Given** a `gm_only` item  
**When** the GM reveals it to Casey, then removes Casey  
**Then** Casey can read it after the reveal and cannot after the removal  
**And** it is removed from Casey's local database on the next synchronization  
**And** both changes are audited as visibility changes

#### Scenario: A GM-only entity never reaches a player device

**Given** campaign A contains `gm_only` entities of every MVP type  
**When** player Casey's device synchronizes campaign A  
**Then** none of them is in Casey's local database  
**And** absence is asserted against the local database and the synchronization payload

#### Scenario: A player cannot change visibility

**Given** player Casey can read an `everyone` NPC  
**When** Casey submits a visibility change for it directly to the API  
**Then** the response is the safe `not_found_or_forbidden` error  
**And** the visibility is unchanged and nothing is audited

### Personal Notes

#### Scenario: A player keeps a private note

**Given** player Casey is in campaign A  
**When** Casey writes a personal note "Elder lied about the road"  
**Then** Casey can read and edit it, online and offline  
**And** it is stored with Casey as its author

#### Scenario Outline: Nobody else reads a personal note

**Given** player Casey wrote a personal note in campaign A  
**When** `<actor>` requests it or synchronizes campaign A  
**Then** access is denied with the safe error  
**And** the note is absent from that actor's local database

| actor |
| --- |
| owner |
| gm |
| assistant_gm |
| player Rowan |

#### Scenario: A personal note takes no attachments or links `[D-15]`

**Given** player Casey wrote a personal note  
**When** Casey requests an attachment upload for the note, or a link from the note to an entity  
**Then** both are rejected and nothing is stored

#### Scenario: A personal note cannot be revealed

**Given** player Casey wrote a personal note  
**When** any actor submits a visibility change for it  
**Then** the change is rejected with the safe error

#### Scenario: A GM-role audit query does not expose personal notes

**Given** player Casey created and edited a personal note  
**When** a GM reads the campaign audit log  
**Then** no event about Casey's note is returned

### Offline

#### Scenario: Full offline CRUD

**Given** a GM's device has campaign A synchronized and no network  
**When** the GM creates an NPC, edits a location, links them, tags them, and deletes an item  
**Then** each change is visible immediately on that device  
**And** each change is queued with a pending indicator  
**And** after reconnecting every change is accepted in order and the pending count reaches 0

#### Scenario: An offline write rejected by the authority is not lost silently

**Given** a GM recorded an offline update to an entity  
**And** the GM's role was changed to `player` before reconnecting  
**When** the device reconnects  
**Then** the update is rejected by the authority  
**And** the GM is shown the rejected change rather than having it vanish

### Audit

#### Scenario Outline: Accepted changes are audited

**Given** a GM performs `<action>` on an entity  
**When** the change is accepted by the authority  
**Then** exactly one audit event with action `<event>` names the actor, the entity, and the change  
**And** the event is not recorded when the change is rejected

| action | event |
| --- | --- |
| create | `entity.created` |
| update | `entity.updated` |
| delete | `entity.deleted` |
| visibility change | `visibility.revealed` or `visibility.unrevealed` |

#### Scenario: Audit does not leak hidden content

**Given** a `gm_only` entity was created and edited  
**When** player Casey reads the campaign audit log  
**Then** no event about that entity is returned and totals exclude it

### Attachments

#### Scenario: A GM attaches a portrait to an NPC

**Given** feature 05 is available and an NPC exists  
**When** the GM attaches a PNG portrait to the NPC  
**Then** the portrait is listed on the NPC  
**And** its readability follows the NPC's visibility

#### Scenario: A hidden entity's attachment is unreachable

**Given** a `gm_only` NPC has an attachment  
**When** player Casey requests the attachment directly  
**Then** no read URL is issued and the response is the safe error

### Integration for Other Features

#### Scenario: Another feature resolves entities through the published API

**Given** an encounter references NPC X and location Y  
**And** player Casey may read Y but not X  
**When** the encounter resolves its references for Casey  
**Then** Y resolves to its summary  
**And** X resolves exactly like a missing reference

#### Scenario: Export carries entities with their visibility

**Given** campaign A has entities and relationships at mixed visibilities  
**When** the campaign is exported and imported  
**Then** entity and relationship counts per type are equal  
**And** every visibility after import equals or is narrower than before export

#### Scenario: Personal notes are not exported `[D-12]`

**Given** player Casey wrote personal notes  
**When** an owner exports the campaign  
**Then** the export contains none of Casey's notes

#### Scenario: Search documents carry visibility

**Given** an entity is revealed to Casey only  
**When** the search contributor indexes the campaign  
**Then** the document for that entity carries visibility `players` naming Casey

## PRD -> BDD Traceability

| PRD Item | Type | Scenario(s) | Status |
| --- | --- | --- | --- |
| Goal: NPC/location/note in under 30 s | Goal | A GM captures an NPC with a name and one line; Quick create asks for nothing but a name | Covered (manual 30 s measurement in task 16) |
| Goal: one implementation, type as configuration | Goal | Every MVP type uses the same screens; A new type needs configuration only | Covered |
| Goal: linkable content | Goal | A GM links an NPC to a faction and a location | Covered |
| Goal: available and editable offline | Goal | Full offline CRUD | Covered |
| Story: NPC in seconds | Story | A GM captures an NPC with a name and one line | Covered |
| Story: attach portrait/map | Story | A GM attaches a portrait to an NPC | Covered |
| Story: link NPC to faction/location | Story | A GM links an NPC to a faction and a location | Covered |
| Story: GM-only by default | Story | A GM captures an NPC...; A new relationship is GM-only | Covered |
| Story: find by name fragment | Story | A GM finds an entity by a name fragment | Covered |
| Story: player keeps notes | Story | A player keeps a private note | Covered |
| FR-001 generic model | FR | Every MVP type uses the same screens; A GM adds a free-form custom field | Covered |
| FR-002 MVP types | FR | Every MVP type uses the same screens | Covered (`scene` enabled, D-02) |
| FR-003 types as configuration | FR | A new type needs configuration only; A type removed from configuration does not lose data; An unknown type is rejected | Covered |
| FR-004 CRUD, soft delete, tombstones | FR | Creating, Editing, Deletion scenarios | Covered |
| FR-005 quick create, Session Mode entry | FR | Quick create asks for nothing but a name; Quick create without an entry-point type | Covered for the entity side and the quick actions (D-14); placement on the Session Mode screen is feature 18 |
| FR-006 single-writer rich text | FR | Rich-Text Description scenarios | Covered (Markdown source as plain text, D-10) |
| FR-007 tags and suggestions | FR | Tags scenarios | Covered |
| FR-008 typed, bidirectional relationships with visibility | FR | Relationships scenarios | Covered (D-07, D-08) |
| FR-009 attachments through 05 | FR | Attachments scenarios; A personal note takes no attachments or links | Covered (entities only, D-15) |
| FR-010 GM-only default, changed through 04 | FR | A GM captures an NPC...; Reveal and un-reveal go through feature 04; A player cannot change visibility | Covered |
| FR-011 list/filter by type, tag, visibility | FR | Filtering narrows the permitted set; Filtering by visibility does not reveal hidden content | Covered |
| FR-012 full offline CRUD | FR | Full offline CRUD | Covered |
| FR-013 conflict presentation | FR | A stale structured edit is a conflict; A deferred conflict surfaces after an offline edit | Covered |
| FR-014 audit events | FR | Accepted changes are audited; Audit does not leak hidden content | Covered |
| FR-015 export and search contributors | FR | Export carries entities with their visibility; Search documents carry visibility | Covered |
| FR-016 module API for 17/18/19 | FR | Another feature resolves entities through the published API | Covered |
| Constraint: one implementation | Constraint | A new type needs configuration only | Covered |
| Constraint: GM-only default | Constraint | A GM captures an NPC...; A new relationship is GM-only | Covered |
| Constraint: enforced server-side and at sync | Constraint | A GM-only entity never reaches a player device; A hidden entity and a missing entity look the same | Covered |
| Constraint: relationships carry their own visibility | Constraint | A relationship is revealed on its own; A relationship cannot outrun its endpoints | Covered |
| Constraint: soft delete leaves broken links | Constraint | Relationships survive as broken links | Covered |
| Constraint: quick create needs no extra choices | Constraint | Quick create asks for nothing but a name | Covered |
| Privacy: GM-only never on a player device | Privacy | A GM-only entity never reaches a player device; Deleting hidden content leaves no trace | Covered |
| Privacy: player notes private to author | Privacy | Nobody else reads a personal note; A GM-role audit query does not expose personal notes | Covered |
| Privacy: exported with GM-only material | Privacy | Export carries entities with their visibility; Personal notes are not exported | Covered (D-12) |
| Success: zero GM-only entities in a player database | Signal | A GM-only entity never reaches a player device | Covered |
| Success: `PRD.md` s.88 acceptance | Signal | A GM captures an NPC...; A GM links...; A GM attaches a portrait; A player keeps a private note | Covered |

## Priority

- P0: every scenario above. Feature 05 is complete, so attachment scenarios are not sequenced
  separately. The export/import round trip is covered by task 17.
- P1: creature statistics, bulk operations, templates, relationship browsing view (not specified
  here; add scenarios when those FRs are scheduled).
- P2: deferred entity types, graph visualization, collaborative text.

## Acceptance Criteria

- [ ] Zero `gm_only` entities, hidden relationships, hidden holds, unseen tombstones, or other
  authors' personal notes in any player local database across the sandbox campaign.
- [ ] Adding one type changes configuration only; the diff contains no screen, route, table,
  migration, or sync-rule change.
- [ ] Quick create stores an entity from name alone; the scripted flow from an open campaign
  completes in under 30 seconds in the manual mid-session measurement.
- [ ] Every accepted create, update, delete, and visibility change has exactly one audit event;
  rejected changes have none.
- [ ] Every stale structured edit produces a conflict with both values; none is last-write-wins.

## Example Test Data

- Valid input: the sandbox campaign (`packages/fixtures/src/campaign.ts`): five locations, six
  NPCs, five items, mixed `gm_only`, `everyone`, and `players` naming player A.
- Invalid input: empty name; type `villain`; tag of 65 characters; relationship from an entity to
  itself; visibility `players` with an empty list (not representable).
- Boundary condition: tag of exactly 64 characters; relationship whose endpoint is a tombstone;
  description saved one second after hold expiry.

## Risks and Gaps

- D-07 decided: hiding an endpoint narrows its relationships (option A), as the scenarios assume.
- D-04/D-05 decided: all GM roles write, players read, as the outline assumes.
- D-14 decided: the frozen `SessionQuickAction.invoke` takes no input, so feature 16's quick action
  opens its own quick-create overlay; the Session Mode placement is verified with feature 18.
- Import half of "Export carries entities with their visibility" is covered by task 17 (B-5 resolved).
- The manual mid-session 30 s quick-create measurement is still open (task 16 protocol).
