import {
  type EffectPlan,
  EMPTY_TARGET_STATE,
  type PlannedOperation,
  type ResolvedPlan,
  resolvePlan,
  type TargetState,
  targetValues,
} from '@rpg/actions/engine';
import { err, ok, type Result } from '@rpg/contracts';
import { compileFormula, evaluateFormula } from '@rpg/formula';
import type { CharacterField, SystemPackage } from '@rpg/systems';

/**
 * The sheet model (`_techspec.md` "Sheet Model"): everything a sheet needs from a package, and every edit as
 * a feature 11 plan. Pure, and it never asks which system it has (`PRD.md` s.89): the declarations say what
 * to render and what a value may be.
 */

export const MAX_SHEET_TEXT = 500;

/** The components built in P0 (D-05). Anything else degrades visibly. */
export type SheetComponent =
  | 'text'
  | 'rich_text'
  | 'number'
  | 'boolean'
  | 'select'
  | 'list'
  | 'repeater'
  | 'resource_pool'
  | 'resource_track'
  | 'inventory'
  | 'conditions'
  | 'computed'
  | 'unsupported';

export interface SheetField {
  readonly field: CharacterField;
  readonly component: SheetComponent;
  readonly gmOnly: boolean;
}

export interface SheetGroup {
  readonly key: string;
  readonly fields: readonly SheetField[];
}

function componentOf(system: SystemPackage, field: CharacterField): SheetComponent {
  switch (field.type) {
    case 'text':
    case 'rich_text':
    case 'number':
    case 'boolean':
    case 'select':
    case 'list':
    case 'repeater':
    case 'inventory':
    case 'computed':
      return field.type;
    case 'counter':
      return 'number';
    case 'condition':
      return 'conditions';
    case 'resource': {
      const resource = system.resources.find((item) => item.key === field.resourceKey);
      if (resource === undefined) return 'unsupported';
      return resource.shape === 'pool' ? 'resource_pool' : 'resource_track';
    }
    default:
      return 'unsupported';
  }
}

/** FR-001: groups in declaration order, each field once, with its component. */
export function sheetLayout(system: SystemPackage): readonly SheetGroup[] {
  const groups = new Map<string, SheetField[]>();
  for (const field of system.characterSchema.fields) {
    const list = groups.get(field.group) ?? [];
    list.push({
      field,
      component: componentOf(system, field),
      gmOnly: isGmOnlyField(system, field),
    });
    groups.set(field.group, list);
  }
  return [...groups].map(([key, fields]) => ({ key, fields }));
}

function isGmOnlyField(system: SystemPackage, field: CharacterField): boolean {
  if (field.gmOnly === true) return true;
  if (field.type === 'resource') {
    return system.resources.some(
      (item) => item.key === field.resourceKey && item.visibility === 'gm_only',
    );
  }
  return false;
}

/**
 * Whether a state path holds a GM-only value (D-06): a GM-only field or its entries, a GM-only resource, a
 * GM-only condition. Those live in the secret row and never reach a player.
 */
export function isGmOnlyPath(system: SystemPackage, path: string): boolean {
  const [root, key] = path.split('.');
  if (key === undefined) return false;
  switch (root) {
    case 'fields':
    case 'entries':
    case 'slots':
      return system.characterSchema.fields.some(
        (field) => field.key === key && field.gmOnly === true,
      );
    case 'resources':
    case 'tracks':
      return system.resources.some((item) => item.key === key && item.visibility === 'gm_only');
    case 'conditions':
      return system.mechanics.conditions.some(
        (item) => item.key === key && item.visibility === 'gm_only',
      );
    case 'inventory':
      return system.characterSchema.fields.some(
        (field) =>
          field.type === 'inventory' && field.inventoryKey === key && field.gmOnly === true,
      );
    default:
      return false;
  }
}

const ENTRY_META = new Set(['_order', '_type', '_removed']);

/** Whether the schema declares the place a path writes (FR-011): nothing undeclared is ever stored. */
export function isDeclaredPath(system: SystemPackage, path: string): boolean {
  const segments = path.split('.');
  const [root, key, third, fourth] = segments;
  if (key === undefined) return false;
  const fields = system.characterSchema.fields;
  switch (root) {
    case 'fields':
      return (
        segments.length === 2 &&
        fields.some(
          (field) =>
            field.key === key &&
            ['text', 'rich_text', 'number', 'counter', 'boolean', 'select'].includes(field.type),
        )
      );
    case 'resources':
      return system.resources.some((item) => item.key === key && item.shape === 'pool');
    case 'tracks':
      return system.resources.some(
        (item) =>
          item.key === key && item.shape === 'track' && item.boxes.some((box) => box.id === third),
      );
    case 'conditions':
      return system.mechanics.conditions.some((item) => item.key === key);
    case 'inventory':
      return system.mechanics.inventory?.key === key;
    case 'slots':
      return fields.some(
        (field) =>
          field.key === key &&
          field.type === 'repeater' &&
          field.slots?.some((slot) => slot.id === third) === true,
      );
    case 'entries': {
      const field = fields.find((item) => item.key === key);
      if (fourth === undefined || field === undefined) return false;
      if (ENTRY_META.has(fourth)) return field.type === 'repeater' || field.type === 'list';
      if (field.type === 'list') return fourth === 'text';
      return field.type === 'repeater' && field.of.some((nested) => nested.key === fourth);
    }
    default:
      return false;
  }
}

/** D-10: the first text field in the summary, else the first text field. */
export function displayNameField(system: SystemPackage): string | undefined {
  const text = system.characterSchema.fields.filter((field) => field.type === 'text');
  return (
    system.characterSchema.summaryFields.find((key) => text.some((field) => field.key === key)) ??
    text[0]?.key
  );
}

export function displayName(system: SystemPackage, state: TargetState): string {
  const key = displayNameField(system);
  const value = key === undefined ? undefined : state.fields[key];
  return typeof value === 'string' && value.trim() !== '' ? value : 'Character';
}

/** One party-panel value (features 18 and 19): a declared summary field, rendered as text. */
export interface SummaryValue {
  readonly key: string;
  readonly label: string;
  readonly text: string;
}

function poolMax(
  system: SystemPackage,
  max: number | { readonly formula: string },
  state: TargetState,
): number | undefined {
  if (typeof max === 'number') return max;
  const compiled = compileFormula(max.formula);
  const value = compiled.ok
    ? evaluateFormula(compiled.value, targetValues(system, state))
    : compiled;
  return value.ok && typeof value.value === 'number' ? value.value : undefined;
}

/**
 * The package's `summaryFields` as text, the display name excepted, from declarations only (`PRD.md` s.89). A
 * GM-only field is never summarized, so a summary is safe wherever the visible state is.
 */
export function characterSummary(system: SystemPackage, state: TargetState): SummaryValue[] {
  const nameKey = displayNameField(system);
  const values = targetValues(system, state);
  return system.characterSchema.summaryFields.flatMap((key): SummaryValue[] => {
    if (key === nameKey) return [];
    const field = system.characterSchema.fields.find((candidate) => candidate.key === key);
    if (field === undefined || isGmOnlyField(system, field)) return [];
    const stored = state.fields[key];
    const one = (text: string): SummaryValue[] => [{ key, label: field.label, text }];
    switch (field.type) {
      case 'text':
      case 'rich_text':
      case 'select':
        return typeof stored === 'string' && stored !== '' ? one(stored) : [];
      case 'number':
      case 'counter':
      case 'computed': {
        const value = values[key];
        return typeof value === 'number' ? one(String(value)) : [];
      }
      case 'boolean':
        return one(values[key] === true ? 'Yes' : 'No');
      case 'resource': {
        const resource = system.resources.find((item) => item.key === field.resourceKey);
        if (resource === undefined) return [];
        if (resource.shape === 'pool') {
          const current = state.resources[resource.key]?.current ?? 0;
          const max = poolMax(system, resource.max, state);
          return one(max === undefined ? String(current) : `${current}/${max}`);
        }
        const marked = resource.boxes.filter(
          (box) => state.tracks[resource.key]?.[box.id] === true,
        ).length;
        return one(`${marked}/${resource.boxes.length} marked`);
      }
      default:
        return [];
    }
  });
}

function leafDefault(field: CharacterField): unknown {
  switch (field.type) {
    case 'text':
      return field.default ?? '';
    case 'rich_text':
      return '';
    case 'number':
    case 'counter':
      return field.default ?? field.min ?? 0;
    case 'boolean':
      return field.default ?? false;
    case 'select':
      return field.default ?? field.values[0];
    default:
      return undefined;
  }
}

/** A new character: every declared default, pools at their default or maximum, the name in place. */
export function initialCharacterState(system: SystemPackage, name: string): TargetState {
  const fields: Record<string, unknown> = {};
  for (const field of system.characterSchema.fields) {
    const value = leafDefault(field);
    if (value !== undefined) fields[field.key] = value;
  }
  const nameKey = displayNameField(system);
  if (nameKey !== undefined) fields[nameKey] = name;
  const base: TargetState = { ...EMPTY_TARGET_STATE, fields };
  const values = targetValues(system, base);
  const resources: Record<string, { current: number }> = {};
  for (const resource of system.resources) {
    if (resource.shape !== 'pool') continue;
    const declared = resource.default ?? resource.max;
    const evaluated =
      typeof declared === 'number'
        ? declared
        : (() => {
            const compiled = compileFormula(declared.formula);
            const result = compiled.ok ? evaluateFormula(compiled.value, values) : compiled;
            return result.ok && typeof result.value === 'number' ? result.value : resource.min;
          })();
    resources[resource.key] = { current: Math.max(resource.min, evaluated) };
  }
  return { ...base, resources };
}

/** D-06: the state split into what everyone who reads the character sees, and the GM-only part. */
export function splitState(
  system: SystemPackage,
  state: TargetState,
): { readonly visible: TargetState; readonly secret: TargetState } {
  const visible: Record<string, Record<string, unknown>> = {};
  const secret: Record<string, Record<string, unknown>> = {};
  for (const root of [
    'fields',
    'resources',
    'tracks',
    'conditions',
    'inventory',
    'slots',
    'entries',
  ]) {
    const node =
      (state as unknown as Record<string, Record<string, unknown> | undefined>)[root] ?? {};
    visible[root] = {};
    secret[root] = {};
    for (const [key, value] of Object.entries(node)) {
      const target = isGmOnlyPath(system, `${root}.${key}`) ? secret : visible;
      (target[root] as Record<string, unknown>)[key] = value;
    }
  }
  return {
    visible: visible as unknown as TargetState,
    secret: secret as unknown as TargetState,
  };
}

/** The two rows read back as one state; GM-only keys win only where they belong. */
export function mergeState(visible: TargetState, secret: TargetState | undefined): TargetState {
  if (secret === undefined) return visible;
  const merged: Record<string, Record<string, unknown>> = {};
  for (const root of [
    'fields',
    'resources',
    'tracks',
    'conditions',
    'inventory',
    'slots',
    'entries',
  ]) {
    merged[root] = {
      ...((visible as unknown as Record<string, Record<string, unknown> | undefined>)[root] ?? {}),
      ...((secret as unknown as Record<string, Record<string, unknown> | undefined>)[root] ?? {}),
    };
  }
  return merged as unknown as TargetState;
}

/** Computed fields (FR-007): recomputed from the state on every read, so they follow their inputs. */
export function computedValues(
  system: SystemPackage,
  state: TargetState,
): Readonly<Record<string, number | boolean>> {
  const values = targetValues(system, state);
  return Object.fromEntries(
    system.characterSchema.fields.flatMap((field) =>
      field.type === 'computed' && values[field.key] !== undefined
        ? [[field.key, values[field.key] as number | boolean]]
        : [],
    ),
  );
}

/** A repeater or list's live entries, in their order. */
export function entriesOf(
  state: TargetState,
  field: string,
): readonly { readonly id: string; readonly values: Readonly<Record<string, unknown>> }[] {
  const node = state.entries?.[field] ?? {};
  return Object.entries(node)
    .filter(([, values]) => values._removed !== true)
    .map(([id, values]) => ({ id, values }))
    .sort(
      (left, right) =>
        Number(left.values._order ?? 0) - Number(right.values._order ?? 0) ||
        left.id.localeCompare(right.id),
    );
}

/** Live inventory items, by slot. */
export function itemsOf(
  state: TargetState,
  inventory: string,
): readonly {
  readonly id: string;
  readonly name: string;
  readonly slot: number;
  readonly size: number;
}[] {
  const node = state.inventory[inventory] ?? {};
  return Object.entries(node)
    .filter(([, item]) => item.removed !== true)
    .map(([id, item]) => ({ id, name: item.name ?? '', slot: item.slot, size: item.size ?? 1 }))
    .sort((left, right) => left.slot - right.slot || left.id.localeCompare(right.id));
}

/* -------------------------------------------------------------------------- */
/* Edits (FR-006, FR-011)                                                     */
/* -------------------------------------------------------------------------- */

export type SheetEdit =
  | { readonly kind: 'set_field'; readonly field: string; readonly value: string | boolean }
  | { readonly kind: 'adjust_field'; readonly field: string; readonly by: number }
  | { readonly kind: 'adjust_resource'; readonly resource: string; readonly by: number }
  | { readonly kind: 'toggle_box'; readonly resource: string; readonly box: string }
  | {
      readonly kind: 'set_slot';
      readonly field: string;
      readonly slot: string;
      readonly text: string;
    }
  | { readonly kind: 'adjust_condition'; readonly condition: string; readonly by: 1 | -1 }
  | {
      readonly kind: 'add_entry';
      readonly field: string;
      readonly id: string;
      readonly entryType?: string;
    }
  | {
      readonly kind: 'set_entry';
      readonly field: string;
      readonly id: string;
      readonly subfield: string;
      readonly value: string | number | boolean;
    }
  | { readonly kind: 'remove_entry'; readonly field: string; readonly id: string }
  | {
      readonly kind: 'add_item';
      readonly id: string;
      readonly name: string;
      readonly slot: number;
      readonly size?: number;
    }
  | { readonly kind: 'move_item'; readonly id: string; readonly slot: number }
  | { readonly kind: 'remove_item'; readonly id: string };

export type SheetEditFailure =
  | 'unknown_field'
  | 'invalid_value'
  | 'too_long'
  | 'not_in_values'
  | 'gm_only'
  | 'nothing_to_change'
  | 'refused';

type Effect = EffectPlan['effects'][number];

/** Runs declared effect kinds through feature 11, so bounds, temporary points, and guards exist once. */
function throughEffects(
  system: SystemPackage,
  state: TargetState,
  effects: readonly Effect[],
  selections: Readonly<Record<string, string | number>> = {},
): Result<ResolvedPlan, SheetEditFailure> {
  const plan: EffectPlan = {
    mode: 'apply',
    items: [],
    options: [],
    values: targetValues(system, state),
    effects,
    optionEffects: {},
  };
  const resolved = resolvePlan({ system, state }, plan, { selections });
  if (resolved.ok) return resolved;
  return err(resolved.error.code === 'nothing_to_apply' ? 'nothing_to_change' : 'refused');
}

function operations(
  operations: readonly PlannedOperation[],
): Result<ResolvedPlan, SheetEditFailure> {
  return ok({ operations, changes: [], followUps: [], edited: false });
}

function leafCheck(field: CharacterField, value: unknown): SheetEditFailure | undefined {
  switch (field.type) {
    case 'text':
    case 'rich_text':
      if (typeof value !== 'string') return 'invalid_value';
      if (
        value.length >
        Math.min(
          MAX_SHEET_TEXT,
          field.type === 'text' ? (field.maxLength ?? MAX_SHEET_TEXT) : MAX_SHEET_TEXT,
        )
      ) {
        return 'too_long';
      }
      return undefined;
    case 'boolean':
      return typeof value === 'boolean' ? undefined : 'invalid_value';
    case 'select':
      return typeof value === 'string' && field.values.includes(value)
        ? undefined
        : 'not_in_values';
    case 'number':
    case 'counter':
      if (!Number.isSafeInteger(value)) return 'invalid_value';
      if (field.min !== undefined && (value as number) < field.min) return 'invalid_value';
      if (field.max !== undefined && (value as number) > field.max) return 'invalid_value';
      return undefined;
    default:
      return 'invalid_value';
  }
}

/**
 * One edit as a plan (D-02). Numbers merge as `delta` and `clamp`; a text or choice is a `set` guarded by
 * the value this device saw. `mayEditGmOnly` is the actor's feature 04 answer; the authority asks again.
 */
export function editPlan(
  system: SystemPackage,
  state: TargetState,
  edit: SheetEdit,
  mayEditGmOnly: boolean,
): Result<ResolvedPlan, SheetEditFailure> {
  const fields = system.characterSchema.fields;
  const guardHidden = (path: string) => !mayEditGmOnly && isGmOnlyPath(system, path);
  switch (edit.kind) {
    case 'set_field': {
      const field = fields.find((item) => item.key === edit.field);
      if (field === undefined || !isDeclaredPath(system, `fields.${edit.field}`)) {
        return err('unknown_field');
      }
      if (guardHidden(`fields.${edit.field}`)) return err('gm_only');
      const defect = leafCheck(field, edit.value);
      if (defect !== undefined) return err(defect);
      return throughEffects(system, state, [
        { effect: 'modify_field', params: { field: edit.field, value: edit.value } },
      ]);
    }
    case 'adjust_field': {
      const field = fields.find((item) => item.key === edit.field);
      if (field?.type !== 'number' && field?.type !== 'counter') return err('unknown_field');
      if (guardHidden(`fields.${edit.field}`)) return err('gm_only');
      if (!Number.isSafeInteger(edit.by) || edit.by === 0) return err('invalid_value');
      return throughEffects(system, state, [
        { effect: 'modify_field', params: { field: edit.field, amount: edit.by } },
      ]);
    }
    case 'adjust_resource': {
      if (!isDeclaredPath(system, `resources.${edit.resource}.current`))
        return err('unknown_field');
      if (guardHidden(`resources.${edit.resource}.current`)) return err('gm_only');
      if (!Number.isSafeInteger(edit.by) || edit.by === 0) return err('invalid_value');
      // Down is damage, so temporary points go first; up is a heal, clamped at the maximum.
      return throughEffects(system, state, [
        {
          effect: edit.by < 0 ? 'apply_damage' : 'heal',
          params: { resource: edit.resource, amount: Math.abs(edit.by) },
        },
      ]);
    }
    case 'toggle_box': {
      if (!isDeclaredPath(system, `tracks.${edit.resource}.${edit.box}`))
        return err('unknown_field');
      if (guardHidden(`tracks.${edit.resource}.${edit.box}`)) return err('gm_only');
      const marked = state.tracks[edit.resource]?.[edit.box] === true;
      return throughEffects(system, state, [
        {
          effect: marked ? 'clear_box' : 'mark_box',
          params: { resource: edit.resource, box: edit.box },
        },
      ]);
    }
    case 'set_slot': {
      if (!isDeclaredPath(system, `slots.${edit.field}.${edit.slot}`)) return err('unknown_field');
      if (guardHidden(`slots.${edit.field}.${edit.slot}`)) return err('gm_only');
      if (edit.text.length > MAX_SHEET_TEXT) return err('too_long');
      const path = `slots.${edit.field}.${edit.slot}`;
      const current = state.slots[edit.field]?.[edit.slot] ?? '';
      if (current === edit.text) return err('nothing_to_change');
      return operations([
        { operation: { op: 'set', path, value: edit.text }, requires: { path, equals: current } },
      ]);
    }
    case 'adjust_condition': {
      if (!isDeclaredPath(system, `conditions.${edit.condition}`)) return err('unknown_field');
      if (guardHidden(`conditions.${edit.condition}`)) return err('gm_only');
      return throughEffects(system, state, [
        {
          effect: edit.by > 0 ? 'add_condition' : 'remove_condition',
          params: { condition: edit.condition },
        },
      ]);
    }
    case 'add_entry': {
      const field = fields.find((item) => item.key === edit.field);
      if (field?.type !== 'repeater' && field?.type !== 'list') return err('unknown_field');
      if (guardHidden(`entries.${edit.field}`)) return err('gm_only');
      if (field.type === 'repeater' && field.maxEntries !== undefined) {
        if (entriesOf(state, edit.field).length >= field.maxEntries) return err('invalid_value');
      }
      if (
        edit.entryType !== undefined &&
        (field.type !== 'repeater' || !field.entryTypes?.some((type) => type.id === edit.entryType))
      ) {
        return err('not_in_values');
      }
      const base = `entries.${edit.field}.${edit.id}`;
      if (state.entries?.[edit.field]?.[edit.id] !== undefined) return err('invalid_value');
      const order =
        Math.max(
          0,
          ...entriesOf(state, edit.field).map((entry) => Number(entry.values._order ?? 0)),
        ) + 1;
      const leaves =
        field.type === 'list'
          ? [{ key: 'text', value: '' as unknown }]
          : field.of.flatMap((nested) => {
              const value = leafDefault(nested);
              return value === undefined ? [] : [{ key: nested.key, value }];
            });
      return operations([
        { operation: { op: 'set', path: `${base}._order`, value: order } },
        ...(edit.entryType === undefined
          ? []
          : [{ operation: { op: 'set' as const, path: `${base}._type`, value: edit.entryType } }]),
        ...leaves.map(({ key, value }) => ({
          operation: { op: 'set' as const, path: `${base}.${key}`, value },
        })),
      ]);
    }
    case 'set_entry': {
      const field = fields.find((item) => item.key === edit.field);
      const path = `entries.${edit.field}.${edit.id}.${edit.subfield}`;
      if (field === undefined || !isDeclaredPath(system, path) || ENTRY_META.has(edit.subfield)) {
        return err('unknown_field');
      }
      if (guardHidden(path)) return err('gm_only');
      const entry = state.entries?.[edit.field]?.[edit.id];
      if (entry === undefined || entry._removed === true) return err('unknown_field');
      const nested =
        field.type === 'repeater'
          ? field.of.find((item) => item.key === edit.subfield)
          : ({ key: 'text', label: 'Text', group: field.group, type: 'text' } as const);
      if (nested === undefined) return err('unknown_field');
      const defect = leafCheck(nested as CharacterField, edit.value);
      if (defect !== undefined) return err(defect);
      const current = entry[edit.subfield];
      if (current === edit.value) return err('nothing_to_change');
      if (typeof current === 'number' && typeof edit.value === 'number') {
        const bounded = nested as { readonly min?: number; readonly max?: number };
        return operations([
          { operation: { op: 'delta', path, value: edit.value - current } },
          {
            operation: {
              op: 'clamp',
              path,
              ...(bounded.min === undefined ? {} : { min: bounded.min }),
              ...(bounded.max === undefined ? {} : { max: bounded.max }),
            },
          },
        ]);
      }
      const guarded =
        typeof current === 'string' || typeof current === 'number' || typeof current === 'boolean';
      return operations([
        {
          operation: { op: 'set', path, value: edit.value },
          ...(guarded ? { requires: { path, equals: current } } : {}),
        },
      ]);
    }
    case 'remove_entry': {
      const path = `entries.${edit.field}.${edit.id}._removed`;
      if (!isDeclaredPath(system, path)) return err('unknown_field');
      if (guardHidden(path)) return err('gm_only');
      if (state.entries?.[edit.field]?.[edit.id] === undefined) return err('unknown_field');
      return operations([{ operation: { op: 'set', path, value: true } }]);
    }
    case 'add_item':
    case 'move_item':
    case 'remove_item': {
      const inventory = system.mechanics.inventory?.key;
      if (inventory === undefined) return err('unknown_field');
      if (guardHidden(`inventory.${inventory}`)) return err('gm_only');
      const base = `inventory.${inventory}.${edit.id}`;
      const existing = state.inventory[inventory]?.[edit.id];
      if (edit.kind === 'remove_item') {
        if (existing === undefined) return err('unknown_field');
        return operations([{ operation: { op: 'set', path: `${base}.removed`, value: true } }]);
      }
      if (!Number.isSafeInteger(edit.slot) || edit.slot < 0) return err('invalid_value');
      if (edit.kind === 'move_item') {
        if (existing === undefined) return err('unknown_field');
        return throughEffects(
          system,
          state,
          [{ effect: 'move_inventory_item', params: { inventory } }],
          { item: edit.id, slot: edit.slot },
        );
      }
      if (existing !== undefined) return err('invalid_value');
      if (edit.name.trim() === '' || edit.name.length > MAX_SHEET_TEXT) return err('invalid_value');
      const size = edit.size ?? 1;
      if (!Number.isSafeInteger(size) || size < 0) return err('invalid_value');
      return operations([
        { operation: { op: 'set', path: `${base}.name`, value: edit.name.trim() } },
        { operation: { op: 'set', path: `${base}.slot`, value: edit.slot } },
        { operation: { op: 'set', path: `${base}.size`, value: size } },
      ]);
    }
    default:
      return err('unknown_field');
  }
}
