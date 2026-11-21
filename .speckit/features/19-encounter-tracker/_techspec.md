# TechSpec: Encounter Tracker

Source: `_prd.md`, `_bdd.md`, `_db.md`, `PRD.md` s.5.5, s.29, s.46, s.47, s.76, s.78, s.89; features 03, 04, 06, 07,
08, 11, 15, 16, 18. P0 only.

## Current Facts

- Feature 11 applies every state change through an `EffectTargetAdapter` per target class and publishes
  `runEffectTargetContract`. Feature 15 registers class `character`; its `editPlan` turns one sheet edit (resource,
  field, box, condition) into a resolved plan, numbers as `delta` plus `clamp`.
- Feature 16 entities hold text only (feature 15 D-09: NPC statistics are not feature 15's). Types `creature`, `npc`,
  and `location` exist.
- Packages declare `characterSchema.summaryFields` "for party panels and encounter participants", and
  `mechanics.conditions` with a Visibility each. Feature 15 publishes `characterSummary`.
- Feature 18 lists the shell's `SessionQuickAction[]` and imports no feature 19 code (unit test). Effect applications
  carrying a `sessionId` appear in its log.

## Decisions (open PRD questions closed; delegated by the owner, 2026-11-05)

- **D-01 Package `@rpg/encounters`.** Root: records, codecs, the pure model, policies, audit declarations, device
  repositories, the export contributor. `/postgres`: schema, repository, service, target adapter, import writer. The
  applier lives in `apps/api/src/modules/encounters`, the screens in `apps/web/src/features/encounters`.
- **D-02 Participants are references (open question 1).** A character participant names the character and holds no
  state: every change targets class `character` (write-through, feature 15's adapter). An entity participant names the
  feature 16 entity and holds an instance state of its own, because entities hold text only and FR-003 requires
  distinct state per instance (three bandits, one entity). The instance state has the pinned package's character
  shape (`initialCharacterState(system, label)`) and changes only through feature 11, class `encounter_participant`.
- **D-03 Ad hoc participants are real entities.** An improvised enemy creates a feature 16 `creature` entity through
  `EntityLocalRepository` (policy default `gm_only`) and then the participant; both queued, in that order.
- **D-04 Instances are numbered (open question 3).** Adding a label that exists in the encounter, or a count above one,
  labels them `Label 1`, `Label 2`, … continuing after the highest number present. Labels are not unique in the
  database, so two offline devices never refuse each other.
- **D-05 Visibility.** The encounter is `everyone` (name, status, environment, location). GM notes are `gm_only`. A
  participant row is `everyone` or `gm_only` and carries only the label and the conditions declared `everyone`. The
  instance state row is `gm_only`, so enemy statistics never reach a player (`PRD.md` s.34). An entity participant
  starts hidden unless its entity's Visibility is `everyone`; an ad hoc participant starts visible (the GM introduces
  it at the table; its entity stays `gm_only`); a character participant is visible. Reveal is one-way in P0
  (`gm_only` → `everyone`).
- **D-06 Conditions (open question 2).** Feature 11 counters (its D-02), no duration. A condition declared `everyone`
  on a visible participant is shown to players; any other condition is GM-only. Duration waits for FR-101.
- **D-07 Display from declarations (FR-004).** A participant shows `characterSummary` of its displayed state. Its
  controls come from the summary fields' declared shapes: `-1`/`+1` on pools, numbers, and counters, a toggle per box
  of a track, and `+`/`-` per declared condition. No system identity is read (guard).
- **D-08 One interaction (FR-006, FR-007, FR-008).** Each control is one `editPlan` resolved through feature 11 and
  queued with `EffectLocalRepository.apply`, with the encounter's session ID, so feature 18's log shows it. Damage is
  `apply_damage` (temporary points first), healing `heal`, conditions `add_condition`/`remove_condition` as counters.
  Rolled actions stay on the character sheet (feature 15 action panel).
- **D-09 No turn order (`PRD.md` s.5.5).** FR-101 waits for a system that declares a turn-based capability.
- **D-10 Lifecycle.** `active → ended`, final. While active: environment, location, participants (add, reveal,
  remove). An ended encounter refuses every change, instance states included (the adapter refuses). A character stays
  the character's: it can change outside the encounter.
- **D-11 Entry points (FR-005).** The shell registers `ENCOUNTER_SESSION_QUICK_ACTIONS` (`encounters.add`, "Add
  encounter") in `SESSION_QUICK_ACTIONS`; `invoke` opens the one mounted `EncounterHost` overlay over the session
  screen (feature 16 D-14 pattern) and resolves when it closes. The start form preselects every character the device
  holds and takes entities and ad hoc names with a count. The dashboard also lists encounters and starts one.
- **D-12 The player view is different data (FR-013).** A player's replica holds encounters, visible participants
  (label and public conditions), and their own character. Never instance states, GM notes, or hidden participants.
- **D-13 Instance state writes do not bump the participant's version.** The participant's version covers its own
  fields only, so a removal queued after offline damage is not a conflict. The state row's version moves.
- **D-14 Audit (FR-014).** `encounter.started`, `encounter.ended`, `encounter.participant_added`,
  `encounter.participant_removed`, `encounter.participant_revealed`, by the authority in the write transaction with
  the mutation ID as origin, carrying the target's Visibility. State changes are feature 11's `effect.applied`. Notes
  are not audited.
- **D-15 Export (FR-015).** `EncounterExporter` (`encounters`, `entities/encounters.json`), mapped as in `_db.md`.
- **D-16 The 15 second budget is a test.** Playwright measures from the "Add encounter" click to the tracker showing
  the party and three instances, and asserts it under 15,000 ms (owner rule: no manual timing).
- **D-17 Deferred.** Turn order, templates, group actions (P1); action economy, difficulty (P2).

## Resource Policies

| Class | owner / gm / assistant_gm | player | observer | Visibility | Sync |
| --- | --- | --- | --- | --- | --- |
| `encounter` | read, create, update | read | none | fixed `everyone` | `encounters` |
| `encounter_gm_note` | read, create, update | none | none | fixed `gm_only` | `encounter_gm_notes` |
| `encounter_participant` | read, create, update, delete | read | none | per row (`everyone`, `gm_only`) | `encounter_participants` |
| `encounter_participant_state` | read | none | none | fixed `gm_only` | `encounter_participant_states` |

## Authority

`EncounterService` (feature `encounters`, one applier per writable table):

- `encounters` insert: GM role, status `active`, no end, bounded text. Audits `encounter.started`. Update: versioned;
  only `environment`, `location_id`, and `status` (to `ended`, with `ended_at`) change, never after the end. Audits
  `encounter.ended`.
- `encounter_gm_notes` insert (once) and versioned update, while the encounter exists.
- `encounter_participants` insert: GM role, the encounter active, a pinned package; an entity participant's uploaded
  conditions must equal the initial state's public part, and the authority writes the state row from the same initial
  state. Update: versioned, reveal only. Tombstone: versioned. Each audited.
- `EncounterParticipantTargetAdapter` (`encounter_participant`): `load` locks the participant and state rows (absent
  for character participants, tombstones, and ended encounters), `save` splits public conditions from the rest,
  `deniedPaths` refuses undeclared paths, `hiddenPaths` reports every path but public conditions (records become
  `gm_only`), `constrain` clamps with the pinned package.
- Codes: `invalid_payload`, `invalid_encounter`, `not_found_or_forbidden` (terminal), `conflict`,
  `authority_unavailable` (retryable).

## Device

- `EncounterLocalRepository`: `list()`, `start()`, `change()`, `end()`. `EncounterNotesLocalRepository`: `get()`,
  `save()`. `ParticipantLocalRepository`: `list()`, `add()`, `reveal()`, `remove()`, `displayed()`, `edit()`.
- Pure model (`domain.ts`): labels, the public split, initial instance state, controls, the change rules.
- Web: `EncounterWorkspace` (GM tracker, start form, player view), `EncounterHost` (overlay), `encounter-source.ts` over
  the browser replica.

## Test Strategy

- Unit: labels, split and merge, controls for all three packages, change rules, device repositories, static markup.
- PostgreSQL: matrix, lifecycle, end is final, participant rules, adapter contract, effects on instances through
  feature 11 (merge, `gm_only` record, refused after the end), audit once on retry, export and import.
- Live PowerSync: a player receives the encounter and the visible participant, never the hidden one, the instance
  states, or the notes.
- E2E: start from Session Mode under 15 seconds, one-interaction damage and condition, the player view, a whole
  encounter offline.

## Changes in Other Features (additive)

- Feature 16: `ENCOUNTER_SOURCE_TYPES`, `AD_HOC_PARTICIPANT_TYPE`, `LOCATION_ENTITY_TYPE` in `types.ts`.
- Feature 11: the runtime registers the `encounter_participant` adapter.
- Feature 07: the `encounters` module in the server and device exports.
- Feature 06: the `encounter` contributor row is built; history stays online-only (`campaign_scope_unprovable`).
- Feature 03: the holds stream gains branches for the updatable classes (derived; no hold is used in P0).
- App shell: `SESSION_QUICK_ACTIONS` gains `ENCOUNTER_SESSION_QUICK_ACTIONS`; `CampaignDashboard` mounts
  `EncounterHost` and `EncounterWorkspace`.

## Out of Scope

P1 and P2 (D-17), maps, tokens, initiative, enemy AI, creature stat blocks on entities.
