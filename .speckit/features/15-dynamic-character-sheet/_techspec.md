# TechSpec: Dynamic Character Sheet

Source: `_prd.md`, `_bdd.md`, `_db.md`, `PRD.md` s.17, s.18, s.57, s.76, s.80, s.89; features 08, 09, 10, 11. P0 only.

## Current Facts

- Feature 11 owns target state, operations, guards, the ledger, and the device overlay. It waits for an
  `EffectTargetAdapter` of class `character` (feature 11 D-13).
- Installed packages: the fixture (a GM-only text field, a repeater, a select, a boolean, a computed field),
  Cairn 2e, and Fate Core. The device reads the campaign's exact pin from `campaign_system_pins`.
- Feature 16's entity and content screens are the UI pattern: static-markup view tests, a Playwright harness.

## Decisions (open PRD questions closed; delegated by the owner, 2026-11-03)

- **D-01 Package `@rpg/characters`.** The root has records, the sheet model, policies, codecs, and device repositories.
  `/postgres` has tables, the service, and the target adapter. Screens live in `apps/web/src/features/characters`.
- **D-02 Every play edit is a feature 11 application (open question 2).** Field edits, resource taps, box marks,
  slots, entries, and inventory moves are resolved plans written through `EffectLocalRepository`. Numbers are
  `delta` plus `clamp`, so they merge. A text or choice is `set`, guarded by the value the device saw, so a concurrent
  edit refuses explicitly instead of overwriting (`PRD.md` s.80). No long text needs a hold, because text is bounded
  at 500 characters (feature 11 state), which the PRD's sheets fit.
- **D-03 Inventory lives in character state (open question 1),** per `_index.md`: `inventory.<key>.<item>.{name, slot, size}`.
- **D-04 Repeaters and lists are entries,** `entries.<field>.<entryId>.<subfield>`, with `_order`, `_type`, and
  `_removed`. A list is a repeater with one `text` subfield. Feature 11's state grammar gains this root, and its repeater
  picks read it.
- **D-05 Components built in P0 (open question 4),** the ones the three installed packages declare: text, rich text,
  number, counter, boolean, select, list, repeater (with entry types and slots), resource (pool and track), inventory,
  condition, computed. `multi_select`, `reference`, and `dice` fields degrade visibly until a package declares one.
- **D-06 GM-only values live in a second row.** `character_secrets` holds the GM-only part of a character's state with a
  fixed `gm_only` Visibility, so a player's replica never holds it. The adapter loads both rows and splits a save by path.
  An application touching a GM-only path is narrowed to `gm_only` (feature 11 D-16). A player's write to one is refused.
- **D-07 Ownership.** Class `character`: GM roles read, create, update, delete. Players read, create, update, and delete
  their own, through an Ownership Rule on `authorUserId`, with GM roles exempt. Visibility is fixed at `players:[owner]`,
  so another player's device never receives it. There is no reveal in P0: party summaries are feature 18's.
- **D-08 A character is pinned to the campaign's system at creation.** The authority checks the pin through feature 02.
  The pinned package interprets the state, and the adapter re-applies its bounds (`clampTargetState`) after every
  application.
- **D-09 NPC statistics are not this feature's (open question 3).** Feature 16 entities stay text. Reuse waits for a
  feature that needs it.
- **D-10 The display name is derived.** It is the first text field in `summaryFields`, else the first text field, else
  "Character". Nothing is stored twice.
- **D-11 Create and delete are this feature's own mutations.** Insert with the initial state, tombstone with the version.
  Edits never bump through this applier.

## Sheet Model

```ts
sheetLayout(system) -> groups of { field, component }        // FR-001, FR-002
displayState(system, base, secrets, pending) -> TargetState   // overlay, then computed values
sheetValues(system, state) -> values for computed fields       // feature 10, recomputed on every change
editPlan(system, state, edit, actor) -> Result<ResolvedPlan>  // FR-006, FR-011
initialCharacterState(system, name) -> TargetState
```

`edit` is one of: set field, change number by, toggle box, set slot, add, update, or remove entry, add or move item,
and change condition. Each becomes guarded or merging operations with the schema's bounds. An invalid value is refused
before anything is queued, and the adapter refuses the same at the authority.

## Authority

- `CharacterService` (create, tombstone) through applier `characters`/`characters`. Create checks the pin, the owner,
  the name, and that the initial state is valid for the schema.
- `CharacterTargetAdapter` (`character`): `load` locks both rows, `save` splits by path, `deniedPaths` refuses GM-only
  paths and undeclared paths for the actor, `hiddenPaths` reports GM-only paths, `constrain` clamps with the pinned package.

## Device

- `CharacterLocalRepository` (list, get, create, remove) and `CharacterSecretsLocalRepository` (read).
- Web: `CharacterWorkspace` with list, create, and sheet, `SheetView` per component, and an action panel that prepares,
  rolls (feature 09), plans, previews, and applies (feature 11).

## Sync

Streams `authorized_characters` (characters, compiled) and the secret rows in the same stream, compiled as `gm_only`.

## Audit

`character.created` and `character.deleted`, server-authored in the write transaction. Edits are audited by feature 11's
`effect.applied`.

## Export and Search

`CharacterExporter` (`characters`): state and secrets per character, restored to the importer, Visibility to the
importer. `CharacterSearchIndexer`: name and the text of summary fields, never GM-only values.

## Test Strategy

Unit tests for the layout, edits, bounds, overlay, and computed values on all three packages. Static markup per component.
On PostgreSQL: matrix, merge, guarded refusal, split rows, zero GM-only values on a player replica, live PowerSync.
E2E: an offline tap shown at once and drained once, and a roll from the sheet.

## Out of Scope

Guided creation, layouts, portraits, advancement, printing (P1, P2).
