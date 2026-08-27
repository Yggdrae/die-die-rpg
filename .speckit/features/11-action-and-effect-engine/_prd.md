# PRD: Action and Effect Engine

Source: `PRD.md` s.19, s.22, s.23, s.27, s.57, s.68, s.76, s.88.
Track: B. Depends on: `SemanticOp` from feature 00, `RollRequest` and `RollResult` from feature 09,
`FormulaSource` from feature 10, action and resource declarations from feature 08.

## Problem

`PRD.md` s.22 shows the whole problem in two examples. One system rolls a d20 and succeeds when
the result is at or under an attribute. Another rolls four Fudge dice plus a skill and reads the
margin. Those are not variations of one procedure; they are different procedures with a shared
shape: roll something, decide an outcome, change some state.

Without this feature, that shape is implemented separately in the sheet, the session screen, and
the encounter tracker, each with its own idea of what damage means. `PRD.md` s.23 lists thirteen
effect kinds that would each be reimplemented three times.

The second problem is offline correctness. An effect that writes an absolute value overwrites a
concurrent change; `PRD.md` s.57 requires semantic operations instead, and the only way to
guarantee that is to make every state change go through one place.

## Goals

- A system declares an action and the platform executes it, with no application code naming the action.
- Every state change from play is a semantic operation, so concurrent offline changes merge
  instead of clobbering (`PRD.md` s.57).
- An effect is previewable before it is applied, so a GM sees what a button will do.
- Resource semantics exist once: clamping, temporary pools, and recovery are not reimplemented per feature.
- Both MVP systems execute their core actions through this engine with no system conditional
  (`PRD.md` s.89).

## Non-Goals

- Dice notation and evaluation. Feature 09 owns them.
- Formula evaluation. Feature 10 owns it.
- Deciding what a system means. Features 12 and 13 declare their own actions and effects.
- Contextual rule suggestions after an outcome (`PRD.md` s.27), deferred to V1.
- Hidden interventions that silently alter outcomes (`PRD.md` s.48, s.86), deferred with the module engine.
- Automation of the fiction. `PRD.md` s.27 is explicit: the application assists and never takes
  narrative control. Every effect application is a GM or player decision.
- Undo. Feature 06 records what happened; reversal is not in MVP.

## Users and Context

### Primary user

A GM mid-session, applying an outcome quickly enough that the table does not wait, and a player
rolling their own action from their sheet.

### Secondary users

Features 15, 18, and 19, which offer actions in their surfaces, and the two system packages,
which declare them.

## User Stories

- As a player, I want to trigger an action from my sheet and see whether it succeeded, so that
  I do not compute it manually.
- As a GM, I want to see what an effect will change before applying it, so that I can decline it.
- As a GM, I want to apply damage without doing arithmetic, so that combat moves.
- As a GM, I want the outcome to reach the player sheet, so that nobody tracks state twice.
- As a GM, I want to apply an effect offline and have it merge correctly on reconnection, so that
  a dead spot does not corrupt the session.

## Functional Requirements

### P0 — MVP

- FR-001: Action execution pipeline: resolve inputs, build a roll request (feature 09), evaluate
  the success condition (feature 10), select an outcome branch, produce an effect plan.
- FR-002: Declarative action support per `PRD.md` s.22, covering both paradigms in that section:
  roll-under an attribute, and roll plus modifier read as a margin.
- FR-003: Effect plan as an explicit, inspectable value produced before anything is written.
  Planning and applying are separate steps.
- FR-004: Effect kinds per `PRD.md` s.23: modify field, apply damage, heal, add condition,
  remove condition, spend resource, gain resource, move inventory item, advance clock,
  trigger event, reveal knowledge, execute roll. Kinds whose owning feature is deferred
  (advance clock, trigger event, reveal knowledge) are declared in the contract and rejected at
  execution with a clear unsupported result, so a package can declare them and a V1 feature can
  enable them without a contract change.
- FR-005: Resource semantics per `PRD.md` s.19: `current`, `min`, `max`, `temporary`, recovery
  rules, visibility. Clamping and temporary-pool ordering live here, once, and the declaration
  lives in feature 08.
- FR-006: Every state change is emitted as a `SemanticOp` from feature 00 (`delta`, `set`, `clamp`)
  rather than an absolute write, so concurrent changes merge (`PRD.md` s.57).
- FR-007: Effect application is transactional per action: all effects in a plan apply, or none do.
- FR-008: Effect application targets any entity carrying resources, not only characters, since
  NPCs and creatures in feature 16 take damage too.
- FR-009: Manual override: a GM can decline, edit, or partially apply a planned effect
  (`PRD.md` s.27, s.41 establish that the GM always decides).
- FR-010: Every applied effect emits an `AuditEvent` (feature 06) with before and after values.
- FR-011: Full offline execution: planning, rolling, and applying work with no network
  (`PRD.md` s.76), through `SyncedRepository`.
- FR-012: Idempotent application, so a queued effect replayed after reconnection does not apply twice.
- FR-013: A published module API for planning and applying an action, consumed by features 15, 18, 19.

### P1 — Important

- FR-101: Conditions as first-class state with duration and expiry, once a system needs more than
  a tagged flag.
- FR-102: Contextual rule suggestion hooks after an outcome (`PRD.md` s.27, V1).
- FR-103: Effect targeting multiple entities in one action.

### P2 — Later

- FR-201: Interception of an outcome by a module (`PRD.md` s.48), which requires the module engine.
- FR-202: Reversal of an applied effect using recorded before-values.

## Behavioral Constraints

- No branch on system identity anywhere (`PRD.md` s.89). Only declarations from feature 08 drive behaviour.
- Planning is pure. It reads state and produces a plan without writing. All writes happen in apply.
- Absolute writes are forbidden where a semantic operation is meaningful (`PRD.md` s.57). A
  resource change expressed as `set` when it is really a `delta` is a defect, because it destroys
  a concurrent change instead of merging with it.
- The application never applies an effect the user did not confirm, except where a system declares
  the effect as automatic and the GM has enabled that. The default is assist, not act (`PRD.md` s.27).
- Effect application respects feature 04. A player cannot apply an effect to a character they do
  not own; the check is server-side, not in the interface.
- An unsupported effect kind fails loudly and never silently no-ops, because a silently skipped
  effect leaves the fiction and the state disagreeing.

## Data and Privacy Considerations

- Effects mutate character and entity state owned by features 15 and 16. This feature writes
  through their published APIs and never touches their tables directly.
- An effect plan may reference GM-only values, so a plan shown to a player must carry only what
  that player may see.
- Audit entries include before and after values and inherit the visibility of their target
  (feature 06).

## Success Signals

- Cairn damage flowing to HP and then to an attribute, and Fate stress and consequences, both
  execute through this engine with no system conditional (`PRD.md` s.89).
- A GM applies a combat outcome in under 10 seconds, supporting the encounter budget in `PRD.md` s.78.
- Concurrent offline damage and healing on the same resource merge to the correct value, with no
  silent overwrite (`PRD.md` s.80).
- A replayed queued effect never doubles a resource change.

## Rollout

Wave 2, Track B, after the dice engine and alongside the formula engine. Features 15, 18, and 19
build their action surfaces against the published planning API and fixture actions before the
MVP system packages exist.

## Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| The engine acquires system-specific special cases under deadline pressure | The central criterion in `PRD.md` s.89 fails and the platform becomes two systems bolted together | Architecture guard from feature 00 FR-009; a case that cannot be declared is escalated as a contract gap in feature 08 |
| Effects written as absolute values | Offline merges silently destroy changes, violating `PRD.md` s.80 | `SemanticOp` required (FR-006); review gate on any direct absolute write to a resource |
| Non-idempotent application on sync replay | Doubled damage, corrupted state, lost trust | Idempotency key per effect application (FR-012); explicit replay test |
| Thirteen effect kinds built for features that do not exist yet | Speculative work, untestable code paths | Deferred kinds are contract-only and rejected at execution (FR-004) |
| Automation overreach | The tool takes narrative control, contradicting `PRD.md` s.27 | Manual override is P0 (FR-009); automatic application is opt-in per system declaration |

## ADR Candidates

- Semantic operations for all play-driven state changes, versus absolute writes (`PRD.md` s.57).
  Shares a boundary with the feature 00 conflict ADR and may be recorded there instead.
- Plan-then-apply as the mandatory shape for every action, versus direct application.

## Open Questions

- TODO: Whether conditions in MVP are simple tags on an entity, or a structured state with duration.
  `PRD.md` s.23 lists add and remove condition; s.47 shows conditions in the tracker; neither defines the model.
- TODO: Where inventory lives, given `move inventory item` is an MVP effect kind and Cairn uses
  slot-based inventory (`PRD.md` s.10). Candidate owners are feature 15 and feature 16.
- TODO: Whether an action can target multiple entities in MVP, or one target only.
- TODO: Ordering semantics when one plan contains several effects on the same resource.
