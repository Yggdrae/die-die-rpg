# TechSpec: Action and Effect Engine

Source: `_prd.md`, `_bdd.md`, `_domain.md`, `_db.md`, `PRD.md` s.19, s.22, s.23, s.27, s.57, s.76, `../_index.md`.
P0 only.

## Current Facts

- `SemanticOp` (`delta`, `set`, `clamp`) is frozen in `@rpg/contracts`. `@rpg/sync` has a generic
  `SemanticMutationApplier` over one record, with no guards and no use by any feature.
- `BrowserLocalWrite` writes one replica row and queues one mutation. There is no local multi-table transaction.
- Feature 15 does not exist, so nothing stores character state yet. `_index.md` says it owns inventory and
  character state and that feature 11 mutates them through its API. Feature 16 entities have only free-form text
  fields, no numeric state.
- Feature 09 published `RollLocalRepository`, feature 10 `compileFormula`/`evaluateFormula`.
- `ActionDeclaration` has `inputs`, `success`, and `outcomes`, but no way to say that `attribute` is picked from
  three fields, that `opposition` is entered by the table, or how `margin` is computed.
- The paradigm packages use the kinds `adjust_resource`, `adjust_field`, `request_action`, `mark_box`, `fill_slot`;
  `PRD.md` s.23 names others.

## Decisions (open PRD questions closed; delegated by the owner, 2026-11-01)

- **D-01 Package `@rpg/actions`.** `src/engine/` is pure: declarations and state in, plan out. It imports
  `@rpg/contracts`, `@rpg/formula`, and types from `@rpg/systems` and `@rpg/dice`, enforced by a guard rule. It takes
  a `RollResult` as input and rolls nothing itself, so planning stays pure. The root adds records and the device
  repository, and `/postgres` adds the table and service.
- **D-02 Conditions are counters (open question 1).** `conditions.<key>` is a number. `stacking: single` is
  clamped to 0..1, so two offline additions still merge. Duration and expiry stay P1 (FR-101).
- **D-03 Inventory lives in target state, owned by feature 15 (open question 2),** per `_index.md`. An item's
  position is `inventory.<key>.<itemId>.slot`. Capacity is a plan warning, not a refusal, because the table decides.
- **D-04 One target per application (open question 3).** Multi-target stays P1 (FR-103). A group is several
  applications.
- **D-05 Ordering (open question 4).** Effects compute in declared order, each on the state the previous one left.
  The authority applies the recorded operations in that same order. Clamp runs after each delta.
- **D-06 Closed kind set.**

  | Kind | Parameters | Source |
  | --- | --- | --- |
  | `apply_damage`, `heal`, `gain_resource`, `spend_resource` | `resource`, `amount` | s.23 |
  | `modify_field` | `field`, one of `amount` or `value` | s.23 |
  | `add_condition`, `remove_condition` | `condition` | s.23 |
  | `move_inventory_item` | `inventory`, optional `item`, `slot` | s.23 |
  | `execute_roll` | `action` | s.23 |
  | `mark_box`, `clear_box` | `resource`, optional `box` | feature 13 FR-007, FR-011 |
  | `fill_slot`, `clear_slot` | `field`, optional `slot`, `text` | feature 13 FR-008, FR-011 |
  | `advance_clock`, `trigger_event`, `reveal_knowledge` | any | deferred, refused at execution |

  The box and slot kinds go beyond s.23's list because Fate cannot be expressed without them. That is the named
  system the PRD requires. The paradigm packages are migrated to this vocabulary. A parameter a declaration leaves
  out is taken from the caller's `selections`, since which box or slot is often the table's call.
- **D-07 Contract addition to `ActionDeclaration` (feature 08 gap, additive).** Optional `picks` (a named value the
  actor picks from declared fields, or from a repeater's entries), `prompts` (a named number the table enters), and
  `derived` (a named formula, in order). No name is reserved: `margin` is whatever the package derives. The engine
  adds only `roll` (modified), `natural`, `successes`, and `success`. Recorded as a contract note in feature 08.
- **D-08 Formulas read only what the action declares.** The context is `inputs`, `picks`, `prompts`, `derived`, and
  the roll names. So a GM-only field cannot enter by accident, and a package with a missing input fails typed.
- **D-09 Target state shape is a published contract.** `{ fields, resources: { key: { current, temporary? } },
  tracks, conditions, inventory, slots }`. Feature 15 stores it. Operations address it by dotted path. Missing
  numbers read as 0, so a condition never added can still receive a delta.
- **D-10 Guards.** `PlannedOperation` is `{ operation: SemanticOp, requires?: { path, atLeast } | { path, equals } }`.
  `SemanticOp` stays frozen. Two offline spends of the last point, or two people filling one slot, refuse the second
  at the authority rather than clamping it into a silent loss.
- **D-11 Local display is an overlay, not a write to the owner's replica.** The record is one replica row, written
  atomically with its queue entry. `projectTargetState(base, records)` applies records the authority has not accepted
  yet. Accepted rows and the owner's new state arrive in one provider checkpoint. So feature 11 never touches feature
  15's replica, FR-007 holds locally by construction, and display cannot double-count.
- **D-12 Authority port, not a dependency.** `EffectTargetAdapter` is registered per target class: `load` (locked
  row), `save`, and optional `deniedPaths` and `constrain`. Feature 11 owns the semantics (`applyPlannedOperations`),
  so an adapter is a thin read and write. Authorization is feature 04's `update` decision on the target's own facts,
  which is how an owner's Ownership Rule applies. `runEffectTargetContract` is the conformance kit features 15 and 19 run.
- **D-13 No adapter ships in P0, by necessity.** Characters arrive with feature 15. The engine, the port, the ledger,
  and the sync path are proven against a probe target on real PostgreSQL. Until feature 15 registers its adapter, a
  production upload is refused with `unknown_target`, and that is loud on purpose. FR-008 is met by the port, shown by
  two different target classes through one engine.
- **D-14 The authority trusts a member's numbers within their permission.** Like rolling (feature 09 ADR-001), a
  modified client could upload a larger delta on a target it may update. The authority checks shape, path grammar,
  guards, permission, and the owner's `constrain` (bounds), but it cannot re-derive a plan without the roll's fiction.
- **D-15 Editing a plan is GM-only, through feature 04.** Policy capability `override` is held by GM roles. A record
  with `edited: true` needs it, with no role comparison in this feature. Declining needs nothing, since it applies less.
- **D-16 The record's Visibility comes from the authority.** It is the target's current Visibility, or `gm_only`
  when the adapter reports a touched path as GM-only. The device's value is only for local display until accepted.
- **D-17 Nothing is automatic in P0.** The PRD allows opt-in automation; no declaration asks for it, and the default
  is assist (`PRD.md` s.27). Every application follows an explicit resolve call.
- **D-19 The service records its own audit event, keyed by the application's id.** Using the mutation envelope
  doubled the event when the same record was resent under a new mutation, because the event's origin was the mutation.
  So these mutations carry no envelope (the applier refuses one), and `recordWithin` runs with the application id as
  its origin. Found by the replay test.
- **D-18 Not exported.** Records are history, like the audit log, which export excludes. A restored campaign carries
  the owner's current state. Feature 18's log reads them while the campaign lives.

## Pipeline

```text
prepareAction(system, key, state, selections) -> PreparedAction { rollRequest, context }
  (caller rolls through feature 09: RollLocalRepository.roll)
planOutcome(prepared, rollResult) -> EffectPlan { success, outcome, items | options }
visiblePlan(plan, system, mayReadGmOnly) -> what a viewer may see
resolvePlan(prepared, plan, decision) -> ResolvedPlan { operations, followUps, edited }
EffectLocalRepository.apply(target, resolved, context) -> queued record
  (upload) DiceRoll-style mutation -> EffectApplicationService.record -> adapter + ledger + audit, one transaction
```

## Module API

```ts
// @rpg/actions: pure engine and device API, consumed by features 15, 18, 19
export function prepareAction(system, actionKey, state, selections): Result<PreparedAction, PlanFailure>;
export function planOutcome(prepared, roll: RollResult): Result<EffectPlan, PlanFailure>;
export function planRecovery(system, state, trigger): Result<EffectPlan, PlanFailure>;
export function visiblePlan(plan, system, mayReadGmOnly: boolean): EffectPlan;
export function resolvePlan(prepared, plan, decision): Result<ResolvedPlan, PlanFailure>;
export function applyPlannedOperations(state, operations): Result<AppliedOperations, ApplyFailure>;
export function projectTargetState(base, records): TargetState;
export function clampTargetState(system, state): TargetState;
export function checkEffectKind(kind: string): string | undefined;          // ExpressionValidators.effect
export function checkSystemEffects(system): readonly { path; message }[];   // ExpressionValidators.effects
export class EffectLocalRepository { apply(...); get(id); list(filter); forTarget(target); }

// @rpg/actions/postgres: authority
export class EffectApplicationService { record(actor, candidate, options); }
export interface EffectTargetAdapter { ... }
```

`@rpg/actions/testing` exports `runEffectTargetContract`.

## Mutation Applier

`EffectApplicationSyncMutationApplier` (feature `actions`, table `effect_applications`): insert only, audit envelope
refused (D-19). `EffectApplicationService.record`, inside one transaction:

1. Shape and path grammar (`checkEffectRecord`), actor is the uploader, `create` decision on the class, `override`
   when edited.
2. Access fence, then claim the identity: insert the ledger row, `ON CONFLICT DO NOTHING`. An existing identical record
   is accepted again with no second effect (D-10 of feature 09's reasoning); anything else is `not_found_or_forbidden`.
3. Adapter by class (`unknown_target` when absent), `load` with a row lock, `update` decision on the target's facts,
   `deniedPaths`.
4. `applyPlannedOperations`, `constrain`, `save`, then fill `changes` and the authority Visibility on the ledger row.
5. Server-authored audit event, `effect.applied`, in the same transaction.

Any refusal after the claim rolls the claim back too. Error codes: `invalid_payload`, `invalid_effect`, `unknown_target`,
`target_changed`, `not_found_or_forbidden` (terminal); `authority_unavailable` (retryable).

## Authorization, Offline, Sync

- **Authorization:** class `effect_application`: `read`, `create` for GM roles and players, `override` for GM roles.
  The target's own class decides `update`.
- **Offline:** plan, roll, and apply run locally. D-11 gives the display.
- **Sync:** compiled stream `authorized_effects`.
- **Conflicts:** semantic merges, guards refuse (D-10). No version conflict, since records are immutable.
- **Realtime, blobs:** N/A.

## Test Strategy

- Unit: every kind, ordering, temporary pools, overflow, guards, overlay, decisions, deferred kinds, visibility of a plan,
  both paradigm packages end to end, source scan for system identity.
- PostgreSQL through the runtime: probe targets of two classes, merge in both orders, replay, resend, identity collision,
  atomic rollback on a fault, authorization matrix, audit in the transaction, zero hidden records on a player replica.
- Sync: drift gate, truth tables, PostgreSQL rendering, simulated replicas, live PowerSync.
- E2E: an offline application in the browser replica, displayed through the overlay, drained once.

## Affected Modules

- New: `packages/actions`, `apps/api/src/modules/actions`, `apps/web/src/features/actions`, migration
  `0015_effect_applications`.
- `packages/systems`: `picks`, `prompts`, `derived`; semantic checks; `effects` port; `invalid_effect`; paradigm packages.
- `apps/api/src/runtime.ts`, `modules/sync/sync-rules.ts`, `modules/audit/contributors.ts`, `modules/systems/registry.ts`.
- `infra/powersync/sync-config.yaml`, `drizzle.config.ts`, `docs/OFFLINE_SYNC_RUNTIME.md`.
- `tools/guard/src/rules.ts`.

## Out of Scope

Rules text (14). Screens (15, 18, 19). Character storage (15). Conditions with duration, suggestions, multi-target,
interception, reversal.
