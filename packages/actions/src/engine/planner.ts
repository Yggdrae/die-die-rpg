import { err, ok, type Result } from '@rpg/contracts';
import type { RollRequest, RollResult } from '@rpg/dice/engine';
import { compileFormula, evaluateFormula } from '@rpg/formula';
import type { SystemPackage } from '@rpg/systems';
import { EFFECT_KINDS } from './kinds.ts';
import {
  applyPlannedOperations,
  type PlannedOperation,
  type StateChange,
  type TargetState,
} from './state.ts';

/**
 * The action pipeline (FR-001, `_techspec.md` "Pipeline"). Pure: declarations and state in, a plan out,
 * nothing rolled and nothing written. No branch on which system or action this is: every name comes from
 * the declaration (`PRD.md` s.89).
 */

type ActionDeclaration = SystemPackage['actions'][number];
type Outcome = ActionDeclaration['outcomes'][number];
type EffectDeclaration = Extract<Outcome['resolution'], { mode: 'apply' }>['effects'][number];
type Values = Readonly<Record<string, number | boolean>>;

export type PickSelection = string | { readonly field: string; readonly entry: string };

export interface ActionSelections {
  readonly picks?: Readonly<Record<string, PickSelection>>;
  readonly prompts?: Readonly<Record<string, number>>;
  /** Parameters an effect leaves to the moment: which box, which slot, the text, the item. */
  readonly effects?: Readonly<Record<string, string | number>>;
}

export type PlanFailureCode =
  | 'unknown_action'
  | 'missing_pick'
  | 'invalid_pick'
  | 'missing_prompt'
  | 'invalid_prompt'
  | 'unknown_identifier'
  | 'formula_failed'
  | 'choice_required'
  | 'unknown_option'
  | 'unknown_item'
  | 'invalid_amount'
  | 'item_refused'
  | 'unsupported_effect'
  | 'needs_input'
  | 'nothing_to_apply';

export interface PlanFailure {
  readonly code: PlanFailureCode;
  /** The name, action, or item it concerns. Never a value of the target's. */
  readonly subject?: string;
}

export interface PlanBasis {
  readonly system: SystemPackage;
  readonly state: TargetState;
  readonly selections?: ActionSelections;
}

export interface PreparedAction extends PlanBasis {
  readonly action: ActionDeclaration;
  /** Hand this to feature 09 (`RollLocalRepository.roll`). Absent when the action has no roll. */
  readonly rollRequest?: RollRequest;
  readonly values: Values;
}

export type PlanItemStatus =
  | 'ready'
  | 'no_effect'
  | 'refused'
  | 'unsupported'
  | 'needs_input'
  | 'follow_up'
  | 'hidden';

export interface PlanItem {
  readonly index: number;
  readonly kind: string;
  readonly status: PlanItemStatus;
  /** Why it is refused, or which selection it needs. */
  readonly reason?: string;
  /** The declared resource, field, condition, or track, for a preview's label. */
  readonly subject?: string;
  readonly amount?: number;
  /** Damage past what the pool could lose; what happens next is the declaration's. */
  readonly overflow?: number;
  readonly warnings?: readonly string[];
  /** `execute_roll`: the action to run next. */
  readonly followUp?: string;
  readonly operations: readonly PlannedOperation[];
  readonly changes: readonly StateChange[];
}

export interface PlanOption {
  readonly id: string;
  readonly label: string;
  readonly items: readonly PlanItem[];
}

export interface EffectPlan {
  readonly action?: string;
  readonly roll?: { readonly natural: number; readonly modified: number };
  readonly success?: boolean;
  readonly outcome?: { readonly id: string; readonly label: string };
  readonly mode: 'apply' | 'choice' | 'none';
  readonly items: readonly PlanItem[];
  readonly options: readonly PlanOption[];
  /** What the amounts are computed from, for recomputing an edit. Removed by `visiblePlan`. */
  readonly values: Values;
  readonly effects: readonly EffectDeclaration[];
  readonly optionEffects: Readonly<Record<string, readonly EffectDeclaration[]>>;
}

export interface PlanDecision {
  readonly option?: string;
  /** By item index. An absent item is accepted. */
  readonly items?: Readonly<Record<number, 'decline' | { readonly amount: number }>>;
  readonly selections?: ActionSelections['effects'];
}

export interface ResolvedPlan {
  readonly action?: string;
  readonly outcome?: string;
  readonly operations: readonly PlannedOperation[];
  readonly changes: readonly StateChange[];
  /** Actions the table asked to run next (`execute_roll`). */
  readonly followUps: readonly string[];
  /** An amount was changed by hand, which needs the `override` capability. */
  readonly edited: boolean;
}

/* -------------------------------------------------------------------------- */
/* Reading a target through its declarations                                  */
/* -------------------------------------------------------------------------- */

function evaluateNumber(source: string, values: Values): Result<number, PlanFailure> {
  const compiled = compileFormula(source);
  const result = compiled.ok ? evaluateFormula(compiled.value, values) : compiled;
  if (!result.ok) {
    return err(
      result.error.code === 'unknown_identifier'
        ? { code: 'unknown_identifier', subject: result.error.message }
        : { code: 'formula_failed', subject: result.error.code },
    );
  }
  return typeof result.value === 'number'
    ? ok(result.value)
    : err({ code: 'formula_failed', subject: 'type_mismatch' });
}

/**
 * Every number and boolean the target's own declarations name, computed fields included (feature 15 reads it
 * to show computed values). Used for bounds and defaults.
 */
export function targetValues(system: SystemPackage, state: TargetState): Values {
  const values: Record<string, number | boolean> = {};
  for (const field of system.characterSchema.fields) {
    const stored = Object.hasOwn(state.fields, field.key) ? state.fields[field.key] : undefined;
    if (field.type === 'number' || field.type === 'counter') {
      values[field.key] = typeof stored === 'number' ? stored : (field.default ?? 0);
    } else if (field.type === 'boolean') {
      values[field.key] = typeof stored === 'boolean' ? stored : (field.default ?? false);
    }
  }
  for (const resource of system.resources) {
    if (resource.shape === 'pool') {
      const stored = Object.hasOwn(state.resources, resource.key)
        ? state.resources[resource.key]
        : undefined;
      values[resource.key] = stored?.current ?? 0;
    }
  }
  // Computed fields read each other in any order; a cycle was refused at load, so this settles.
  const computed = system.characterSchema.fields.flatMap((field) =>
    field.type === 'computed' ? [field] : [],
  );
  for (let pass = 0; pass <= computed.length; pass += 1) {
    let changed = false;
    for (const field of computed) {
      if (Object.hasOwn(values, field.key)) continue;
      const compiled = compileFormula(field.value.formula);
      const value = compiled.ok ? evaluateFormula(compiled.value, values) : compiled;
      if (value.ok) {
        values[field.key] = value.value;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return values;
}

function poolBounds(
  system: SystemPackage,
  state: TargetState,
  key: string,
): Result<{ readonly min: number; readonly max: number }, PlanFailure> {
  const pool = system.resources.find((resource) => resource.key === key);
  if (pool?.shape !== 'pool') return err({ code: 'formula_failed', subject: key });
  if (typeof pool.max === 'number') return ok({ min: pool.min, max: pool.max });
  const max = evaluateNumber(pool.max.formula, targetValues(system, state));
  return max.ok ? ok({ min: pool.min, max: max.value }) : max;
}

function pickValue(
  system: SystemPackage,
  state: TargetState,
  pick: NonNullable<ActionDeclaration['picks']>[number],
  selection: PickSelection | undefined,
): Result<number | boolean, PlanFailure> {
  if (selection === undefined) return err({ code: 'missing_pick', subject: pick.name });
  const fieldKey = typeof selection === 'string' ? selection : selection.field;
  if (!pick.fields.includes(fieldKey)) return err({ code: 'invalid_pick', subject: pick.name });
  if (typeof selection === 'string') {
    if (pick.entryField !== undefined) return err({ code: 'invalid_pick', subject: pick.name });
    const value = targetValues(system, state)[fieldKey];
    return value === undefined ? err({ code: 'invalid_pick', subject: pick.name }) : ok(value);
  }
  if (pick.entryField === undefined) return err({ code: 'invalid_pick', subject: pick.name });
  const entries =
    state.entries !== undefined && Object.hasOwn(state.entries, fieldKey)
      ? state.entries[fieldKey]
      : undefined;
  const entry =
    entries !== undefined && Object.hasOwn(entries, selection.entry)
      ? entries[selection.entry]
      : undefined;
  if (entry === undefined || entry._removed === true) {
    return err({ code: 'invalid_pick', subject: pick.name });
  }
  const value = Object.hasOwn(entry, pick.entryField) ? entry[pick.entryField] : undefined;
  return typeof value === 'number' || typeof value === 'boolean'
    ? ok(value)
    : err({ code: 'invalid_pick', subject: pick.name });
}

/* -------------------------------------------------------------------------- */
/* FR-001: prepare, then plan                                                 */
/* -------------------------------------------------------------------------- */

/** Resolves what the actor picked and entered, ready to roll. Reads only what the action declares. */
export function prepareAction(
  system: SystemPackage,
  actionKey: string,
  state: TargetState,
  selections: ActionSelections = {},
): Result<PreparedAction, PlanFailure> {
  const action = system.actions.find((candidate) => candidate.key === actionKey);
  if (action === undefined) return err({ code: 'unknown_action', subject: actionKey });
  const own = targetValues(system, state);
  const values: Record<string, number | boolean> = {};
  for (const input of action.inputs) {
    const value = own[input];
    if (value !== undefined) values[input] = value;
  }
  for (const pick of action.picks ?? []) {
    const value = pickValue(system, state, pick, selections.picks?.[pick.name]);
    if (!value.ok) return value;
    values[pick.name] = value.value;
  }
  for (const prompt of action.prompts ?? []) {
    const value = selections.prompts?.[prompt.name] ?? prompt.default;
    if (value === undefined) return err({ code: 'missing_prompt', subject: prompt.name });
    if (!Number.isSafeInteger(value)) return err({ code: 'invalid_prompt', subject: prompt.name });
    values[prompt.name] = value;
  }
  const numeric = Object.fromEntries(
    Object.entries(values).filter(
      (entry): entry is [string, number] => typeof entry[1] === 'number',
    ),
  );
  return ok({
    system,
    state,
    selections,
    action,
    values,
    ...(action.roll === undefined
      ? {}
      : { rollRequest: { expression: action.roll.dice, inputs: numeric } }),
  });
}

/** The first outcome whose condition holds, in declared order; no condition always holds. */
function selectOutcome(
  action: ActionDeclaration,
  values: Values,
): Result<Outcome | undefined, PlanFailure> {
  for (const outcome of action.outcomes) {
    if (outcome.when === undefined) return ok(outcome);
    const compiled = compileFormula(outcome.when.formula);
    const result = compiled.ok ? evaluateFormula(compiled.value, values) : compiled;
    if (!result.ok) {
      return err(
        result.error.code === 'unknown_identifier'
          ? { code: 'unknown_identifier', subject: result.error.message }
          : { code: 'formula_failed', subject: outcome.id },
      );
    }
    if (result.value === true) return ok(outcome);
  }
  return ok(undefined);
}

export function planOutcome(
  prepared: PreparedAction,
  roll?: RollResult,
): Result<EffectPlan, PlanFailure> {
  const { action } = prepared;
  const values: Record<string, number | boolean> = {
    ...prepared.values,
    ...(roll === undefined
      ? {}
      : {
          roll: roll.modified,
          natural: roll.natural,
          ...(roll.successes === undefined ? {} : { successes: roll.successes }),
        }),
  };
  for (const derived of action.derived ?? []) {
    const compiled = compileFormula(derived.value.formula);
    const result = compiled.ok ? evaluateFormula(compiled.value, values) : compiled;
    if (!result.ok) {
      return err(
        result.error.code === 'unknown_identifier'
          ? { code: 'unknown_identifier', subject: result.error.message }
          : { code: 'formula_failed', subject: derived.name },
      );
    }
    values[derived.name] = result.value;
  }
  let success: boolean | undefined;
  if (action.success !== undefined) {
    const compiled = compileFormula(action.success.formula);
    const result = compiled.ok ? evaluateFormula(compiled.value, values) : compiled;
    if (!result.ok) {
      return err(
        result.error.code === 'unknown_identifier'
          ? { code: 'unknown_identifier', subject: result.error.message }
          : { code: 'formula_failed', subject: 'success' },
      );
    }
    success = result.value === true;
    values.success = success;
  }
  const selected = selectOutcome(action, values);
  if (!selected.ok) return selected;
  const outcome = selected.value;
  const base = {
    action: action.key,
    ...(roll === undefined ? {} : { roll: { natural: roll.natural, modified: roll.modified } }),
    ...(success === undefined ? {} : { success }),
    values,
  };
  if (outcome === undefined) {
    return ok({ ...base, mode: 'none', items: [], options: [], effects: [], optionEffects: {} });
  }
  const label = { id: outcome.id, label: outcome.label };
  const { resolution } = outcome;
  if (resolution.mode === 'apply') {
    return ok({
      ...base,
      outcome: label,
      mode: 'apply',
      items: computeItems(prepared, values, resolution.effects, {}, {}),
      options: [],
      effects: resolution.effects,
      optionEffects: {},
    });
  }
  return ok({
    ...base,
    outcome: label,
    mode: 'choice',
    items: [],
    options: resolution.options.map((option) => ({
      id: option.id,
      label: option.label,
      items: computeItems(prepared, values, option.effects, {}, {}),
    })),
    effects: [],
    optionEffects: Object.fromEntries(
      resolution.options.map((option) => [option.id, option.effects]),
    ),
  });
}

/* -------------------------------------------------------------------------- */
/* FR-004, FR-005: what each kind does                                        */
/* -------------------------------------------------------------------------- */

type Draft = Omit<PlanItem, 'index' | 'kind' | 'changes'>;

function refused(reason: string, subject?: string): Draft {
  return {
    status: 'refused',
    reason,
    operations: [],
    ...(subject === undefined ? {} : { subject }),
  };
}

function needs(reason: string, subject?: string): Draft {
  return {
    status: 'needs_input',
    reason,
    operations: [],
    ...(subject === undefined ? {} : { subject }),
  };
}

function poolChange(
  path: string,
  delta: number,
  bounds: { readonly min: number; readonly max: number },
): readonly PlannedOperation[] {
  return [
    { operation: { op: 'delta', path, value: delta } },
    { operation: { op: 'clamp', path, min: bounds.min, max: bounds.max } },
  ];
}

interface Scope {
  readonly basis: PlanBasis;
  readonly state: TargetState;
  readonly values: Values;
  readonly selected: Readonly<Record<string, string | number>>;
}

function parameter(scope: Scope, effect: EffectDeclaration, name: string): unknown {
  return Object.hasOwn(effect.params, name) ? effect.params[name] : scope.selected[name];
}

function amountOf(
  scope: Scope,
  effect: EffectDeclaration,
  override: number | undefined,
): Result<number, PlanFailure> {
  if (override !== undefined) return ok(override);
  const declared = effect.params.amount;
  if (typeof declared === 'number') return ok(declared);
  if (typeof declared === 'object') return evaluateNumber(declared.formula, scope.values);
  return err({ code: 'invalid_amount', subject: effect.effect });
}

function resourceEffect(
  scope: Scope,
  effect: EffectDeclaration,
  override: number | undefined,
): Draft {
  const { system } = scope.basis;
  const key = String(effect.params.resource);
  const pool = system.resources.find((resource) => resource.key === key);
  if (pool?.shape !== 'pool') return refused('not_a_pool', key);
  const amount = amountOf(scope, effect, override);
  if (!amount.ok) return refused(amount.error.code, key);
  const bounds = poolBounds(system, scope.state, key);
  if (!bounds.ok) return refused(bounds.error.code, key);
  const size = Math.max(0, amount.value);
  if (size === 0) return { status: 'no_effect', subject: key, amount: 0, operations: [] };
  const stored = Object.hasOwn(scope.state.resources, key) ? scope.state.resources[key] : undefined;
  const current = stored?.current ?? 0;
  const path = `resources.${key}.current`;
  switch (effect.effect) {
    case 'apply_damage': {
      const temporary = pool.temporary ? (stored?.temporary ?? 0) : 0;
      const fromTemporary = Math.min(temporary, size);
      const rest = size - fromTemporary;
      const absorbed = Math.min(rest, Math.max(0, current - bounds.value.min));
      return {
        status: 'ready',
        subject: key,
        amount: size,
        ...(rest > absorbed ? { overflow: rest - absorbed } : {}),
        operations: [
          ...(fromTemporary > 0
            ? poolChange(`resources.${key}.temporary`, -fromTemporary, {
                min: 0,
                max: Number.MAX_SAFE_INTEGER,
              })
            : []),
          ...(rest > 0 ? poolChange(path, -rest, bounds.value) : []),
        ],
      };
    }
    case 'spend_resource':
      if (current - size < bounds.value.min) return refused('insufficient', key);
      return {
        status: 'ready',
        subject: key,
        amount: size,
        operations: [
          {
            operation: { op: 'delta', path, value: -size },
            requires: { path, atLeast: bounds.value.min + size },
          },
          { operation: { op: 'clamp', path, min: bounds.value.min, max: bounds.value.max } },
        ],
      };
    default:
      if (effect.params.temporary === true) {
        if (!pool.temporary) return refused('no_temporary_pool', key);
        return {
          status: 'ready',
          subject: key,
          amount: size,
          operations: poolChange(`resources.${key}.temporary`, size, {
            min: 0,
            max: Number.MAX_SAFE_INTEGER,
          }),
        };
      }
      return {
        status: 'ready',
        subject: key,
        amount: size,
        operations: poolChange(path, size, bounds.value),
      };
  }
}

function fieldEffect(scope: Scope, effect: EffectDeclaration, override: number | undefined): Draft {
  const key = String(effect.params.field);
  const field = scope.basis.system.characterSchema.fields.find((item) => item.key === key);
  if (field === undefined) return refused('unknown_field', key);
  const path = `fields.${key}`;
  if (field.type === 'number' || field.type === 'counter') {
    const amount = amountOf(scope, effect, override);
    if (!amount.ok) return refused(amount.error.code, key);
    if (amount.value === 0) return { status: 'no_effect', subject: key, amount: 0, operations: [] };
    return {
      status: 'ready',
      subject: key,
      amount: amount.value,
      operations: [
        { operation: { op: 'delta', path, value: amount.value } },
        ...(field.min === undefined && field.max === undefined
          ? []
          : [
              {
                operation: {
                  op: 'clamp' as const,
                  path,
                  ...(field.min === undefined ? {} : { min: field.min }),
                  ...(field.max === undefined ? {} : { max: field.max }),
                },
              },
            ]),
      ],
    };
  }
  const value = effect.params.value;
  if (typeof value !== 'string' && typeof value !== 'boolean' && typeof value !== 'number') {
    return refused('invalid_value', key);
  }
  // A choice or a text is guarded by what the device saw, so a concurrent edit refuses instead of
  // overwriting (`PRD.md` s.80). A value never written has nothing to guard against.
  const current = Object.hasOwn(scope.state.fields, key) ? scope.state.fields[key] : undefined;
  const guarded =
    typeof current === 'string' || typeof current === 'number' || typeof current === 'boolean';
  if (current === value) return { status: 'no_effect', subject: key, operations: [] };
  return {
    status: 'ready',
    subject: key,
    operations: [
      {
        operation: { op: 'set', path, value },
        ...(guarded ? { requires: { path, equals: current } } : {}),
      },
    ],
  };
}

function conditionEffect(scope: Scope, effect: EffectDeclaration): Draft {
  const key = String(effect.params.condition);
  const condition = scope.basis.system.mechanics.conditions.find((item) => item.key === key);
  if (condition === undefined) return refused('unknown_condition', key);
  const path = `conditions.${key}`;
  const current = Object.hasOwn(scope.state.conditions, key)
    ? (scope.state.conditions[key] ?? 0)
    : 0;
  if (effect.effect === 'remove_condition') {
    if (current === 0) return { status: 'no_effect', subject: key, operations: [] };
    return {
      status: 'ready',
      subject: key,
      operations: [
        { operation: { op: 'delta', path, value: -1 } },
        { operation: { op: 'clamp', path, min: 0 } },
      ],
    };
  }
  if (condition.stacking === 'single' && current >= 1) {
    return { status: 'no_effect', subject: key, operations: [] };
  }
  return {
    status: 'ready',
    subject: key,
    operations: [
      { operation: { op: 'delta', path, value: 1 } },
      ...(condition.stacking === 'single'
        ? [{ operation: { op: 'clamp' as const, path, min: 0, max: 1 } }]
        : []),
    ],
  };
}

function boxEffect(scope: Scope, effect: EffectDeclaration): Draft {
  const key = String(effect.params.resource);
  const track = scope.basis.system.resources.find((resource) => resource.key === key);
  if (track?.shape !== 'track') return refused('not_a_track', key);
  const marks = Object.hasOwn(scope.state.tracks, key) ? scope.state.tracks[key] : undefined;
  const isMarked = (id: string) =>
    marks !== undefined && Object.hasOwn(marks, id) && marks[id] === true;
  const marking = effect.effect === 'mark_box';
  const chosen = parameter(scope, effect, 'box');
  const box =
    chosen === undefined
      ? track.boxes.find((candidate) => isMarked(candidate.id) !== marking)?.id
      : String(chosen);
  if (box === undefined) return refused(marking ? 'track_full' : 'track_empty', key);
  if (!track.boxes.some((candidate) => candidate.id === box)) return refused('unknown_box', key);
  const path = `tracks.${key}.${box}`;
  if (isMarked(box) === marking) {
    return marking
      ? refused('box_marked', key)
      : { status: 'no_effect', subject: key, operations: [] };
  }
  return {
    status: 'ready',
    subject: key,
    operations: [
      {
        operation: { op: 'set', path, value: marking },
        ...(marking ? { requires: { path, equals: false } } : {}),
      },
    ],
  };
}

function slotEffect(scope: Scope, effect: EffectDeclaration): Draft {
  const key = String(effect.params.field);
  const field = scope.basis.system.characterSchema.fields.find((item) => item.key === key);
  if (field?.type !== 'repeater' || field.slots === undefined) return refused('not_slots', key);
  const filled = Object.hasOwn(scope.state.slots, key) ? scope.state.slots[key] : undefined;
  const textOf = (id: string) =>
    filled !== undefined && Object.hasOwn(filled, id) ? filled[id] : '';
  const filling = effect.effect === 'fill_slot';
  const chosen = parameter(scope, effect, 'slot');
  if (chosen === undefined) return needs('slot', key);
  const slot = String(chosen);
  if (!field.slots.some((candidate) => candidate.id === slot)) return refused('unknown_slot', key);
  const path = `slots.${key}.${slot}`;
  if (!filling) {
    if (textOf(slot) === '') return { status: 'no_effect', subject: key, operations: [] };
    return {
      status: 'ready',
      subject: key,
      operations: [{ operation: { op: 'set', path, value: '' } }],
    };
  }
  if (textOf(slot) !== '') return refused('slot_filled', key);
  const text = parameter(scope, effect, 'text');
  if (typeof text !== 'string' || text.trim() === '') return needs('text', key);
  return {
    status: 'ready',
    subject: key,
    operations: [{ operation: { op: 'set', path, value: text }, requires: { path, equals: '' } }],
  };
}

function inventoryEffect(scope: Scope, effect: EffectDeclaration): Draft {
  const { inventory } = scope.basis.system.mechanics;
  if (inventory === undefined) return refused('no_inventory');
  const item = parameter(scope, effect, 'item');
  if (typeof item !== 'string') return needs('item', inventory.key);
  const slot = parameter(scope, effect, 'slot');
  if (typeof slot !== 'number' || !Number.isSafeInteger(slot) || slot < 0) {
    return needs('slot', inventory.key);
  }
  const capacity =
    typeof inventory.capacity === 'number'
      ? ok(inventory.capacity)
      : evaluateNumber(inventory.capacity.formula, targetValues(scope.basis.system, scope.state));
  return {
    status: 'ready',
    subject: inventory.key,
    // The table decides (D-03): over capacity is shown, never refused.
    ...(capacity.ok && slot >= capacity.value ? { warnings: ['over_capacity'] } : {}),
    operations: [
      { operation: { op: 'set', path: `inventory.${inventory.key}.${item}.slot`, value: slot } },
    ],
  };
}

function draftEffect(scope: Scope, effect: EffectDeclaration, override: number | undefined): Draft {
  const kind = EFFECT_KINDS.get(effect.effect);
  if (kind === undefined) return refused('unknown_kind');
  if (kind.deferred === true) return { status: 'unsupported', operations: [] };
  switch (effect.effect) {
    case 'apply_damage':
    case 'heal':
    case 'gain_resource':
    case 'spend_resource':
      return resourceEffect(scope, effect, override);
    case 'modify_field':
      return fieldEffect(scope, effect, override);
    case 'add_condition':
    case 'remove_condition':
      return conditionEffect(scope, effect);
    case 'mark_box':
    case 'clear_box':
      return boxEffect(scope, effect);
    case 'fill_slot':
    case 'clear_slot':
      return slotEffect(scope, effect);
    case 'move_inventory_item':
      return inventoryEffect(scope, effect);
    default:
      return { status: 'follow_up', followUp: String(effect.params.action), operations: [] };
  }
}

/** D-05: declared order, each effect on the state the previous one left. */
function computeItems(
  basis: PlanBasis,
  values: Values,
  effects: readonly EffectDeclaration[],
  decisions: NonNullable<PlanDecision['items']>,
  selected: NonNullable<PlanDecision['selections']>,
): readonly PlanItem[] {
  let state = basis.state;
  return effects.flatMap((effect, index) => {
    const decision = decisions[index];
    if (decision === 'decline') return [];
    const override = typeof decision === 'object' ? decision.amount : undefined;
    const draft = draftEffect(
      {
        basis,
        state,
        values,
        selected: { ...(basis.selections?.effects ?? {}), ...selected },
      },
      effect,
      override,
    );
    const applied = applyPlannedOperations(state, draft.operations);
    if (!applied.ok) {
      return [
        {
          ...refused(applied.error.code),
          index,
          kind: effect.effect,
          changes: [],
        } satisfies PlanItem,
      ];
    }
    state = applied.value.state;
    return [
      { ...draft, index, kind: effect.effect, changes: applied.value.changes } satisfies PlanItem,
    ];
  });
}

/* -------------------------------------------------------------------------- */
/* FR-009: a person decides                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Turns a plan and a decision into what gets applied. Refused, unsupported, and unfinished items fail the
 * whole resolution unless they were declined, so nothing is silently skipped. Declining everything is
 * `nothing_to_apply`, and no record is made.
 */
export function resolvePlan(
  basis: PlanBasis,
  plan: EffectPlan,
  decision: PlanDecision = {},
): Result<ResolvedPlan, PlanFailure> {
  let effects: readonly EffectDeclaration[];
  if (plan.mode === 'choice') {
    if (decision.option === undefined) return err({ code: 'choice_required' });
    const chosen = Object.hasOwn(plan.optionEffects, decision.option)
      ? plan.optionEffects[decision.option]
      : undefined;
    if (chosen === undefined) return err({ code: 'unknown_option', subject: decision.option });
    effects = chosen;
  } else {
    effects = plan.effects;
  }
  const items = decision.items ?? {};
  for (const [index, entry] of Object.entries(items)) {
    if (effects[Number(index)] === undefined) return err({ code: 'unknown_item', subject: index });
    if (typeof entry === 'object' && !Number.isSafeInteger(entry.amount)) {
      return err({ code: 'invalid_amount', subject: index });
    }
  }
  const computed = computeItems(basis, plan.values, effects, items, decision.selections ?? {});
  for (const item of computed) {
    const subject = String(item.index);
    if (item.status === 'refused') return err({ code: 'item_refused', subject });
    if (item.status === 'unsupported')
      return err({ code: 'unsupported_effect', subject: item.kind });
    if (item.status === 'needs_input')
      return err({ code: 'needs_input', subject: item.reason ?? subject });
  }
  const operations = computed.flatMap((item) => item.operations);
  const followUps = computed.flatMap((item) =>
    item.followUp === undefined ? [] : [item.followUp],
  );
  if (operations.length === 0 && followUps.length === 0) return err({ code: 'nothing_to_apply' });
  const final = applyPlannedOperations(basis.state, operations);
  return ok({
    ...(plan.action === undefined ? {} : { action: plan.action }),
    ...(plan.outcome === undefined ? {} : { outcome: plan.outcome.id }),
    operations,
    changes: final.ok ? final.value.changes : [],
    followUps,
    edited: Object.values(items).some((entry) => typeof entry === 'object'),
  });
}

/* -------------------------------------------------------------------------- */
/* Recovery, bounds, and what a viewer may see                                */
/* -------------------------------------------------------------------------- */

/** FR-005: the declared recovery for a trigger, as a plan like any other. */
export function planRecovery(
  system: SystemPackage,
  state: TargetState,
  trigger: string,
): Result<EffectPlan, PlanFailure> {
  const effects: EffectDeclaration[] = [];
  for (const resource of system.resources) {
    for (const rule of resource.recovery) {
      if (rule.trigger !== trigger) continue;
      if (resource.shape === 'pool') {
        const bounds = poolBounds(system, state, resource.key);
        if (!bounds.ok) return bounds;
        const current = Object.hasOwn(state.resources, resource.key)
          ? (state.resources[resource.key]?.current ?? 0)
          : 0;
        effects.push({
          effect: 'heal',
          params: {
            resource: resource.key,
            amount: rule.amount ?? Math.max(0, bounds.value.max - current),
          },
        });
      } else {
        const marks = Object.hasOwn(state.tracks, resource.key) ? state.tracks[resource.key] : {};
        for (const box of resource.boxes) {
          if (marks !== undefined && Object.hasOwn(marks, box.id) && marks[box.id] === true) {
            effects.push({ effect: 'clear_box', params: { resource: resource.key, box: box.id } });
          }
        }
      }
    }
  }
  const values = targetValues(system, state);
  return ok({
    mode: effects.length === 0 ? 'none' : 'apply',
    items: computeItems({ system, state }, values, effects, {}, {}),
    options: [],
    values,
    effects,
    optionEffects: {},
  });
}

/** Authority side of D-14: the owner re-applies declared bounds after operations from any device. */
export function clampTargetState(system: SystemPackage, state: TargetState): TargetState {
  const operations: PlannedOperation[] = [];
  for (const resource of system.resources) {
    if (resource.shape !== 'pool') continue;
    const bounds = poolBounds(system, state, resource.key);
    if (bounds.ok) {
      operations.push({
        operation: {
          op: 'clamp',
          path: `resources.${resource.key}.current`,
          min: bounds.value.min,
          max: bounds.value.max,
        },
      });
    }
  }
  for (const field of system.characterSchema.fields) {
    if (
      (field.type === 'number' || field.type === 'counter') &&
      (field.min !== undefined || field.max !== undefined) &&
      typeof (Object.hasOwn(state.fields, field.key) ? state.fields[field.key] : undefined) ===
        'number'
    ) {
      operations.push({
        operation: {
          op: 'clamp',
          path: `fields.${field.key}`,
          ...(field.min === undefined ? {} : { min: field.min }),
          ...(field.max === undefined ? {} : { max: field.max }),
        },
      });
    }
  }
  const clamped = applyPlannedOperations(state, operations);
  return clamped.ok ? clamped.value.state : state;
}

function gmOnlySubjects(system: SystemPackage): ReadonlySet<string> {
  return new Set([
    ...system.resources.flatMap((item) => (item.visibility === 'gm_only' ? [item.key] : [])),
    ...system.mechanics.conditions.flatMap((item) =>
      item.visibility === 'gm_only' ? [item.key] : [],
    ),
    ...system.characterSchema.fields.flatMap((item) => (item.gmOnly === true ? [item.key] : [])),
  ]);
}

/** Whether any path touches a declared GM-only value (the authority's D-16 narrowing uses this too). */
export function touchesGmOnly(
  system: SystemPackage,
  operations: readonly PlannedOperation[],
): boolean {
  const hidden = gmOnlySubjects(system);
  return operations.some(({ operation }) => hidden.has(operation.path.split('.')[1] ?? ''));
}

/**
 * A plan as one viewer may see it (`_prd.md` privacy). A GM-only subject keeps its place, so a player sees
 * that something happens, without the numbers. The amounts' working values are removed for everyone but a
 * GM, because a context may hold values the viewer was never sent.
 */
export function visiblePlan(
  plan: EffectPlan,
  system: SystemPackage,
  mayReadGmOnly: boolean,
): EffectPlan {
  if (mayReadGmOnly) return plan;
  const hidden = gmOnlySubjects(system);
  const redact = (item: PlanItem): PlanItem =>
    item.subject !== undefined && hidden.has(item.subject)
      ? { index: item.index, kind: item.kind, status: 'hidden', operations: [], changes: [] }
      : item;
  return {
    ...plan,
    values: {},
    items: plan.items.map(redact),
    options: plan.options.map((option) => ({ ...option, items: option.items.map(redact) })),
  };
}
