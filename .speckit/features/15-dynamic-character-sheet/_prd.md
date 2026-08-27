# PRD: Dynamic Character Sheet

Source: `PRD.md` s.5.2, s.17, s.18, s.19, s.57, s.68, s.69, s.76, s.87 Test 2, s.88, s.89.
Track: C. Depends on: `characterSchema` and resource declarations from feature 08,
`SemanticOp` and `SyncedRepository` from feature 00, action planning from feature 11,
formula evaluation from feature 10.

## Problem

The character sheet is where the platform succeeds or fails visibly. `PRD.md` s.17 states the
mechanism: the frontend receives a schema and generates the sheet. Section 18 lists the component
vocabulary that makes it possible, and s.89 names the acceptance test: the same sheet page renders
Cairn and Fate with no code that knows which.

That constraint is not aesthetic. The moment a sheet contains a Cairn branch, every future system
requires a code change, and the product becomes a two-system application with extension theatre
around it.

## Goals

- One sheet implementation renders any conforming system, with no system branch (`PRD.md` s.89).
- A player edits their own sheet instantly and offline (`PRD.md` s.76).
- Concurrent edits merge or conflict explicitly, never silently overwrite (`PRD.md` s.80).
- A player can act from the sheet without navigating elsewhere, since that is where they live
  during a session.

## Non-Goals

- System-specific layouts or bespoke sheet designs per system. Advanced sheet layouts are V2
  (`PRD.md` s.72).
- Character creation procedures as guided flows. MVP creates a character against the schema;
  guided creation is a package concern in P1 of features 12 and 13.
- NPC and creature statistics blocks. Feature 16 owns them, though it may reuse this rendering.
- Action resolution logic. Feature 11 owns it; the sheet triggers and displays.
- Sheet customization by the user.
- Printing and PDF export.

## Users and Context

### Primary user

A player, during a session, on whatever device they brought. They open the sheet once and stay
there, so it is the only screen many players will ever judge the product by.

### Secondary users

A GM viewing and adjusting player sheets, and running NPCs that use the same rendering.

## User Stories

- As a player, I want my sheet to appear correctly for the system we play, so that I recognize it
  as my character rather than as a form.
- As a player, I want to change a resource in one tap, so that tracking damage does not interrupt play.
- As a player, I want to roll directly from a field, so that the sheet is where I act.
- As a player, I want my edits to work with no signal, so that the venue network is not my problem.
- As a GM, I want to adjust a player resource when they are away from their device, so that the
  table keeps moving.
- As a player, I want fields I am not allowed to change to be clearly not mine to change, so that
  I do not have to ask.

## Functional Requirements

### P0 — MVP

- FR-001: Schema-driven rendering. The sheet is generated from the `characterSchema` declared by
  the pinned system version (`PRD.md` s.17). No layout is written per system.
- FR-002: Component set per `PRD.md` s.18: text, number, boolean, counter, resource bar, select,
  multi-select, list, repeater, inventory, condition, rich text, reference, computed field, dice.
  Components not required by an MVP system package are deferred rather than built speculatively.
- FR-003: Character create, read, update, and soft delete, scoped to a campaign.
- FR-004: Character ownership: a player owns their character; a GM may view and edit characters in
  their campaign. Decided by feature 04, never in the interface.
- FR-005: Field-level editability from the schema and the actor role, so a player edits authorized
  fields only (`PRD.md` s.69).
- FR-006: Resource controls rendered from resource declarations, with increment and decrement
  emitting `SemanticOp` deltas rather than absolute writes (`PRD.md` s.57).
- FR-007: Computed fields evaluated through feature 10, recomputed when a dependency changes,
  using the dependency extraction in feature 10 FR-010.
- FR-008: Roll from a field or an action declared by the system, executed through feature 11 and
  feature 09, with the result visible in context.
- FR-009: Full offline operation: view, edit, roll, and change resources with no network
  (`PRD.md` s.76), through `SyncedRepository`.
- FR-010: Conflict presentation when a structured edit conflicts, using the shared surface from
  feature 03 FR-009. Never a silent overwrite (`PRD.md` s.80).
- FR-011: Validation from the schema at the boundary, so an out-of-range value is rejected before
  it is stored (`PRD.md` s.16).
- FR-012: Character list for a campaign, filtered by what the actor may see.
- FR-013: Every field and resource change emits an `AuditEvent` (feature 06).
- FR-014: `ExportableModule` and `SearchIndexer` implementations for features 07 and 20.

### P1 — Important

- FR-101: Inventory interactions beyond display, including the move-inventory-item effect from
  feature 11 FR-004, needed by slot-based systems (`PRD.md` s.10).
- FR-102: Sheet sections and progressive disclosure for larger schemas, ahead of the d20 systems
  in `PRD.md` s.11.
- FR-103: Character portrait through feature 05.

### P2 — Later

- FR-201: Advanced sheet layouts declared by a package (`PRD.md` s.72).
- FR-202: Character advancement and levelling, once a system with levels is supported
  (`PRD.md` s.11).

## Behavioral Constraints

- No branch on system identity anywhere in this feature (`PRD.md` s.89). This is the single most
  visible place the rule can be broken and the easiest place to break it under deadline pressure.
- Every resource mutation is a semantic operation, never an absolute write, because two people
  adjusting the same resource offline is a normal event at a table (`PRD.md` s.57).
- Editability is enforced server-side. Disabling an input is presentation only (`PRD.md` s.34).
- The sheet reads and writes locally first; a server round trip is never on the interaction path
  (`PRD.md` s.52).
- A field the actor may not see is absent from the payload, not hidden in the interface, because
  a GM-only field on a player device is exposed regardless of rendering (feature 04).
- Rendering an unknown component type degrades visibly and reports the schema gap, rather than
  failing silently or crashing the sheet.

## Data and Privacy Considerations

- Character data is player-owned content. A GM can see and edit it within their campaign; nobody
  outside the campaign can.
- A schema may declare GM-only fields on a character, which must be filtered at the sync boundary
  (feature 03 FR-013), not at render.
- Character data synchronizes to player devices and persists there until membership ends
  (feature 03 FR-014).
- Sheet data is exported with the campaign in feature 07.

## Success Signals

- `PRD.md` s.89: the same sheet page renders Cairn and Fate with no system branch, verified by the
  architecture guard in feature 00 FR-009.
- `PRD.md` s.87 Test 2: a player resource change applies locally at once, reaches the GM, and a
  player without permission cannot make it.
- A resource change completes in one interaction with no perceptible delay, offline.
- `PRD.md` s.88 acceptance: a player views their sheet, edits authorized fields, and rolls.
- Zero silent overwrites on concurrent sheet edits (`PRD.md` s.80).

## Rollout

Wave 1, Track C, and the first Track C feature because it is the clearest test of the schema-driven
approach. It builds against the fixture character schema from feature 00, which is deliberately
neither Cairn nor Fate, so a hidden assumption about either system surfaces immediately rather
than at integration.

## Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| A system-specific branch appears in the sheet under deadline pressure | The central architectural criterion fails in the most visible feature | Architecture guard from feature 00 FR-009; fixture schema is neither MVP system, so shortcuts do not work |
| Component vocabulary insufficient for Fate aspects or Cairn slots | The sheet cannot render an MVP system | Draft both packages in wave 1 (features 12, 13); missing components are a feature 08 contract finding, not a local special case |
| Absolute writes used for resources | Concurrent offline changes silently overwrite (`PRD.md` s.80) | `SemanticOp` required (FR-006); review gate on direct resource writes |
| Computed field recomputation loops or lags | The sheet becomes slow or unstable | Dependency extraction and cycle detection from feature 10 FR-010 at package load |
| Editability enforced only in the interface | A player edits a field they should not | Server-side enforcement through feature 04 (FR-005); matrix test from feature 04 FR-010 |
| Fifteen component types built before any system needs them | Speculative work in the largest Track C feature | Build only components the MVP packages declare (FR-002) |

## ADR Candidates

- Schema-driven generic rendering versus per-system sheet implementations. This is the product
  bet from `PRD.md` s.3 and s.89 made concrete, and the alternative is what most competitors do,
  which makes it worth recording.

## Open Questions

- TODO: Where inventory state lives, shared with feature 11 open questions. A slot-based inventory
  is character state, but the move-inventory-item effect is owned by feature 11.
- TODO: Whether long text fields on a sheet are single-writer or optimistic-concurrency in MVP,
  pending the same decision in feature 03.
- TODO: Whether NPC statistics in feature 16 reuse this rendering or have their own lighter one.
  Reuse is attractive and creates a cross-feature dependency that the split otherwise avoids.
- TODO: Which of the fifteen `PRD.md` s.18 components the MVP packages actually require.
