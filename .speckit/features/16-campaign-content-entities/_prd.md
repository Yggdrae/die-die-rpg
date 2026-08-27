# PRD: Campaign Content and Entities

Source: `PRD.md` s.29, s.30, s.31, s.36, s.68, s.76, s.78, s.88.
Track: C. Depends on: `EntityEnvelope` and `Visibility` from feature 00, authorization from
feature 04, attachments from feature 05.

## Problem

A campaign is mostly prose and small records: NPCs, locations, items, factions, notes
(`PRD.md` s.29). Today GMs keep them in Notion, Obsidian, Drive, and paper, which is precisely
the fragmentation named in `PRD.md` s.2. Bringing them into the application only helps if creating
one is faster than typing a line in a notes app: s.78 sets that bar at under 30 seconds for an NPC.

The design question is whether these are separate features or one. Sixteen content types in s.29,
each with its own screens, would consume the whole MVP. Section 30 answers it: entities share
identity, tags, metadata, notes, attachments, relationships, visibility, custom fields, and audit.
The differences are small enough to be data.

## Goals

- A GM captures an NPC, a location, or a note in under 30 seconds (`PRD.md` s.78).
- One entity implementation serves every content type, so a new type is configuration.
- Content is linkable, so a campaign becomes a connected structure rather than a folder
  (`PRD.md` s.36).
- Everything is available and editable offline (`PRD.md` s.76).

## Non-Goals

- Clues, secrets, quests, events, clocks, and timeline. Deferred to V1 (`PRD.md` s.71), though
  they are expected to be entity types when they arrive.
- Knowledge graph visualization (`PRD.md` s.70 excludes it from MVP).
- Player-visible knowledge differing from world truth (`PRD.md` s.37), deferred with secrets.
- Collaborative simultaneous editing of long text. Yjs is V1 (`PRD.md` s.57).
- Character sheets. Feature 15 owns characters.
- Map tooling, tokens, grids (`PRD.md` s.70).

## Users and Context

### Primary user

A GM in two very different modes. Preparing between sessions, deliberate and comfortable at a
keyboard. Improvising mid-session, when an unplanned NPC needs a name and one line, and anything
slower than thirty seconds means they use paper instead.

### Secondary users

Players reading revealed content and writing their own notes (`PRD.md` s.6).

## User Stories

- As a GM, I want to create an NPC with a name and a line of description in seconds, so that
  improvisation is captured rather than lost.
- As a GM, I want to attach a portrait or a map to an entity, so that material lives with its subject.
- As a GM, I want to link an NPC to a faction and a location, so that I can see who belongs where
  (`PRD.md` s.36).
- As a GM, I want everything GM-only by default, so that a half-written idea is never exposed.
- As a GM, I want to find an entity by a fragment of its name, so that I do not browse lists mid-session.
- As a player, I want to keep my own notes, so that I do not need a second application.

## Functional Requirements

### P0 — MVP

- FR-001: Generic entity model per `PRD.md` s.30: id, name, type, tags, metadata, notes,
  attachments, relationships, visibility, custom fields, audit information.
- FR-002: MVP entity types from the `PRD.md` s.68 scope: NPC, creature, location, item, faction,
  note, scene. Types in `PRD.md` s.29 belonging to deferred features are not implemented.
- FR-003: Type definitions as configuration, so adding a type does not require new screens.
- FR-004: Create, read, update, and soft delete, campaign-scoped, with tombstones (`PRD.md` s.57).
- FR-005: Quick create: name plus one field, under 30 seconds including navigation
  (`PRD.md` s.78). Available from Session Mode through the feature 18 quick action slot.
- FR-006: Rich text description per entity, edited by a single writer at a time in MVP.
- FR-007: Tags, free-form, campaign-scoped, with reuse suggestions.
- FR-008: Typed relationships between entities per `PRD.md` s.36, for example member of, lives at,
  knows. Relationships are bidirectionally navigable and carry their own visibility.
- FR-009: Attachments on any entity through feature 05.
- FR-010: Visibility per entity, GM-only by default for GM-authored content, changed through feature 04.
- FR-011: Listing and filtering by type, tag, and visibility.
- FR-012: Full offline create, read, update, delete (`PRD.md` s.76).
- FR-013: Conflict presentation on concurrent structured edits, using the shared surface from
  feature 03 (`PRD.md` s.80).
- FR-014: Audit events for create, update, delete, and visibility change (feature 06).
- FR-015: `ExportableModule` and `SearchIndexer` implementations for features 07 and 20.
- FR-016: A published module API for other features to reference and resolve entities, used by
  features 17, 18, 19.

### P1 — Important

- FR-101: Creature and NPC statistics driven by the system package, reusing feature 15 rendering
  so a creature in an encounter has resources to damage.
- FR-102: Bulk operations: tag, change visibility, delete.
- FR-103: Templates for frequently created entity types.
- FR-104: Relationship browsing view, short of the deferred graph visualization.

### P2 — Later

- FR-201: Clues, secrets, quests, events, clocks, timeline as additional entity types
  (`PRD.md` s.71).
- FR-202: Knowledge graph visualization (`PRD.md` s.70).
- FR-203: Collaborative editing of long text (`PRD.md` s.57).

## Behavioral Constraints

- One implementation for all types. A per-type code path is the failure this feature exists to
  avoid, and it fails the same way system branching fails in feature 15.
- GM-authored content defaults to GM-only (`PRD.md` s.34). Exposure by forgetting a setting is
  the failure mode that matters.
- Visibility is enforced server-side and at the sync boundary, never by hiding in the interface
  (feature 04).
- Relationships carry their own visibility, since knowing that two NPCs are connected is itself a
  revealable fact (`PRD.md` s.37).
- Deleting an entity soft-deletes it and leaves relationships resolvable as broken rather than
  cascading deletes through a GM campaign structure.
- Quick create must not require choosing a type, a visibility, and a location before typing a name.
  Every required field is a second against the 30-second budget.

## Data and Privacy Considerations

- Campaign content is the most sensitive user data in the product: unpublished creative work,
  and secrets whose exposure ruins the experience the product exists to support.
- Content synchronizes to devices of members who may see it and persists there (feature 03).
  GM-only content must never reach a player device.
- Player notes are visible to their author; whether a GM can read them must be explicit rather
  than assumed, since players will assume privacy.
- Content is exported with the campaign in feature 07, including GM-only material.

## Success Signals

- `PRD.md` s.78: a simple NPC created in under 30 seconds, measured mid-session in the validation
  campaign, not in isolation.
- `PRD.md` s.88 acceptance: the GM creates an NPC, creates a location, attaches files, and creates notes.
- Adding a new entity type requires configuration only, demonstrated by adding one during MVP.
- Zero GM-only entities present in a player local database.

## Rollout

Wave 2, Track C. Attachments arrive in wave 4, so entity attachment support builds against the
`AttachmentRef` contract and fixture attachments first. The sandbox campaign in `PRD.md` s.82 is
the working dataset: five locations, six NPCs, five items.

## Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Per-type screens and code paths | The feature grows to sixteen small features and consumes the MVP | Type as configuration (FR-003); one implementation, asserted by adding a type without new screens |
| Quick create too slow | GMs revert to paper mid-session and the product loses its core use case | Name plus one field (FR-005); measured against the s.78 budget in a real session, not a demo |
| Default visibility set to everyone | A GM secret exposed by omission, unrecoverable | GM-only default (FR-010); asserted by test |
| Relationship model over-designed ahead of the deferred knowledge graph | Complexity now for a V1 feature | Typed edges with visibility, no graph traversal, no inference, no visualization |
| Rich text conflicts without Yjs | Lost edits on the longest content in the product | Single-writer in MVP (FR-006) with explicit conflict surface (FR-013); Yjs in V1 |
| Player note privacy assumed rather than specified | A trust violation the first time a GM reads one | Resolve the open question below before shipping player notes |

## ADR Candidates

- A single generic entity model with type as configuration, versus distinct models per content
  type. The alternative is the conventional choice and would consume the MVP, which makes the
  reasoning worth recording for the V1 additions.

## Open Questions

- TODO: Whether a GM can read player-authored notes. `PRD.md` s.6 grants players note-taking and
  does not state who else can see it. Players will assume privacy; the default must be deliberate.
- TODO: Whether custom fields (`PRD.md` s.30) are free-form key-value or schema-declared in MVP.
- TODO: Whether creature statistics reuse feature 15 rendering, shared with the feature 15 open
  question. Reuse creates the only Track C internal dependency in the plan.
- TODO: Whether scenes belong to this feature or to feature 18, given `PRD.md` s.44 shows a
  current scene in Session Mode.
