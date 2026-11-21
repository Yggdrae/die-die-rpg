import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RollResult } from '@rpg/dice/engine';
import type { SystemPackage } from '@rpg/systems';
import { aspectSystem, slotSystem } from '@rpg/systems/testing/paradigms';
import {
  applyPlannedOperations,
  checkEffectKind,
  checkSystemEffects,
  clampTargetState,
  EFFECT_KINDS,
  type EffectPlan,
  EMPTY_TARGET_STATE,
  isOperationPath,
  type PlanItem,
  planOutcome,
  planRecovery,
  prepareAction,
  projectTargetState,
  resolvePlan,
  type TargetState,
  touchesGmOnly,
  visiblePlan,
} from './index.ts';

type Effect = { effect: string; params: Record<string, unknown> };

function rollOf(modified: number, natural = modified): RollResult {
  return {
    terms: [
      {
        kind: 'dice',
        sign: 1,
        die: 'd20',
        faces: [{ value: natural, kept: true }],
        subtotal: natural,
      },
    ],
    natural,
    modified,
  };
}

function state(overrides: Partial<TargetState> = {}): TargetState {
  return { ...EMPTY_TARGET_STATE, ...overrides };
}

/** A package whose only action applies the given effects, so each kind is tested by itself. */
function withEffects(
  effects: readonly Effect[],
  base: SystemPackage = testSystem(),
): SystemPackage {
  const system = structuredClone(base) as unknown as {
    actions: Record<string, unknown>[];
  };
  system.actions = [
    {
      key: 'act',
      label: 'Act',
      roll: { dice: '1d20' },
      inputs: [],
      outcomes: [{ id: 'only', label: 'Only', resolution: { mode: 'apply', effects } }],
    },
  ];
  return system as unknown as SystemPackage;
}

function testSystem(): SystemPackage {
  const system = structuredClone(slotSystem()) as unknown as {
    resources: Record<string, unknown>[];
    characterSchema: { fields: Record<string, unknown>[] };
    mechanics: { conditions: Record<string, unknown>[] };
  };
  system.resources.push(
    {
      key: 'ward',
      label: 'Ward',
      shape: 'pool',
      min: 0,
      max: 5,
      temporary: true,
      visibility: 'everyone',
      spendable: false,
      recovery: [{ trigger: 'dawn', label: 'Back up', amount: 2 }],
    },
    {
      key: 'luck',
      label: 'Luck',
      shape: 'pool',
      min: 0,
      max: 3,
      temporary: false,
      visibility: 'gm_only',
      spendable: true,
      recovery: [],
    },
    {
      key: 'strain',
      label: 'Strain',
      shape: 'track',
      boxes: [
        { id: 'one', label: '1' },
        { id: 'two', label: '2' },
      ],
      visibility: 'everyone',
      spendable: false,
      recovery: [{ trigger: 'dawn', label: 'Clears' }],
    },
  );
  system.characterSchema.fields.push(
    { key: 'title', label: 'Title', group: 'identity', type: 'text' },
    {
      key: 'harm',
      label: 'Harm',
      group: 'status',
      type: 'repeater',
      of: [{ key: 'text', label: 'Text', group: 'status', type: 'text' }],
      slots: [
        { id: 'mild', label: 'Mild', severity: 2 },
        { id: 'severe', label: 'Severe', severity: 6 },
      ],
    },
  );
  system.mechanics.conditions.push({
    key: 'stunned',
    label: 'Stunned',
    stacking: 'single',
    visibility: 'everyone',
  });
  return system as unknown as SystemPackage;
}

function plan(
  system: SystemPackage,
  target: TargetState,
): {
  readonly plan: EffectPlan;
  readonly item: PlanItem;
  readonly basis: { system: SystemPackage; state: TargetState };
} {
  const prepared = prepareAction(system, 'act', target);
  if (!prepared.ok) throw new Error(prepared.error.code);
  const planned = planOutcome(prepared.value, rollOf(10));
  if (!planned.ok) throw new Error(planned.error.code);
  return {
    plan: planned.value,
    item: planned.value.items[0] as PlanItem,
    basis: { system, state: target },
  };
}

function one(effect: Effect, target: TargetState = state()) {
  return plan(withEffects([effect]), target);
}

function after(item: PlanItem, path: string): unknown {
  return item.changes.find((change) => change.path === path)?.after;
}

const POOL = (current: number, temporary?: number) => ({
  current,
  ...(temporary === undefined ? {} : { temporary }),
});

describe('operations on target state', () => {
  test('a delta on a missing number starts from 0, and the input is never changed', () => {
    const before = state();
    const applied = applyPlannedOperations(before, [
      { operation: { op: 'delta', path: 'conditions.fatigue', value: 2 } },
      { operation: { op: 'delta', path: 'resources.guard.current', value: 3 } },
    ]);
    expect(applied.ok && applied.value.state.conditions).toEqual({ fatigue: 2 });
    expect(applied.ok && applied.value.state.resources).toEqual({ guard: { current: 3 } });
    expect(before).toEqual(EMPTY_TARGET_STATE);
  });

  test('changes hold the first before and the last after of each path', () => {
    const applied = applyPlannedOperations(state({ resources: { a: POOL(4) } }), [
      { operation: { op: 'delta', path: 'resources.a.current', value: -9 } },
      { operation: { op: 'clamp', path: 'resources.a.current', min: 0, max: 5 } },
    ]);
    expect(applied.ok && applied.value.changes).toEqual([
      { path: 'resources.a.current', before: 4, after: 0 },
    ]);
  });

  test('deltas commute: concurrent damage and healing merge in either order', () => {
    const base = state({ resources: { a: POOL(10) } });
    const damage = { operation: { op: 'delta' as const, path: 'resources.a.current', value: -3 } };
    const heal = { operation: { op: 'delta' as const, path: 'resources.a.current', value: 2 } };
    for (const order of [
      [damage, heal],
      [heal, damage],
    ]) {
      const applied = applyPlannedOperations(base, order);
      expect(applied.ok && applied.value.state.resources.a?.current).toBe(9);
    }
  });

  test.each([
    'x',
    'fields',
    'fields.a.b',
    'resources.a',
    'resources.a.max',
    'tracks.a',
    'inventory.a.b',
    'inventory.a.b.weight',
    'other.a',
    'fields.__proto__',
    'fields.constructor',
    'resources.__proto__.current',
    'constructor.a',
    '__proto__.polluted',
    'fields.a b',
    '',
  ])('the path %p is refused', (path) => {
    expect(isOperationPath(path)).toBe(false);
    const applied = applyPlannedOperations(state(), [{ operation: { op: 'set', path, value: 1 } }]);
    expect(applied.ok ? undefined : applied.error.code).toBe('invalid_path');
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
  });

  test.each([
    [{ op: 'delta', path: 'fields.a', value: 1.5 }, { fields: { a: 1 } }],
    [{ op: 'delta', path: 'fields.a', value: 1 }, { fields: { a: 'text' } }],
    [{ op: 'delta', path: 'fields.a', value: Number.MAX_SAFE_INTEGER }, { fields: { a: 9 } }],
    [{ op: 'set', path: 'fields.a', value: { nested: true } }, {}],
    [{ op: 'set', path: 'fields.a', value: 'x'.repeat(501) }, {}],
    [{ op: 'set', path: 'fields.a', value: 1.5 }, {}],
  ] as const)('%j on %j is an invalid value', (operation, overrides) => {
    const applied = applyPlannedOperations(state(overrides as Partial<TargetState>), [
      { operation: operation as never },
    ]);
    expect(applied.ok ? undefined : applied.error.code).toBe('invalid_value');
  });

  test('a failed guard refuses everything, including earlier operations', () => {
    const base = state({ resources: { a: POOL(1), b: POOL(5) } });
    const applied = applyPlannedOperations(base, [
      { operation: { op: 'delta', path: 'resources.b.current', value: -1 } },
      {
        operation: { op: 'delta', path: 'resources.a.current', value: -2 },
        requires: { path: 'resources.a.current', atLeast: 2 },
      },
    ]);
    expect(applied).toEqual({
      ok: false,
      error: { code: 'target_changed', path: 'resources.a.current' },
    });
    expect(base.resources.b?.current).toBe(5);
  });

  test('guards see defaults for what was never written', () => {
    const fill = {
      operation: { op: 'set' as const, path: 'slots.harm.mild', value: 'Broken arm' },
      requires: { path: 'slots.harm.mild', equals: '' },
    };
    const first = applyPlannedOperations(state(), [fill]);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = applyPlannedOperations(first.value.state, [fill]);
    expect(second.ok ? undefined : second.error.code).toBe('target_changed');
  });

  test('the overlay applies pending applications in order and skips what would refuse', () => {
    const base = state({ resources: { a: POOL(1) } });
    const spend = {
      operation: { op: 'delta' as const, path: 'resources.a.current', value: -1 },
      requires: { path: 'resources.a.current', atLeast: 1 },
    };
    const projected = projectTargetState(base, [
      { id: 'b', appliedAt: '2026-11-01T10:00:01.000Z', operations: [spend] },
      { id: 'a', appliedAt: '2026-11-01T10:00:00.000Z', operations: [spend] },
      {
        id: 'c',
        appliedAt: '2026-11-01T10:00:02.000Z',
        operations: [{ operation: { op: 'delta', path: 'resources.a.current', value: 4 } }],
      },
    ]);
    expect(projected.resources.a?.current).toBe(4);
    expect(base.resources.a?.current).toBe(1);
  });
});

describe('every kind', () => {
  test('apply_damage: delta then clamp, with the overflow reported', () => {
    const { item } = one(
      { effect: 'apply_damage', params: { resource: 'ward', amount: 5 } },
      state({ resources: { ward: POOL(2) } }),
    );
    expect(item.status).toBe('ready');
    expect(item.overflow).toBe(3);
    expect(item.operations.map(({ operation }) => operation.op)).toEqual(['delta', 'clamp']);
    expect(after(item, 'resources.ward.current')).toBe(0);
  });

  test('apply_damage: temporary points go first', () => {
    const { item } = one(
      { effect: 'apply_damage', params: { resource: 'ward', amount: 3 } },
      state({ resources: { ward: POOL(4, 2) } }),
    );
    expect(after(item, 'resources.ward.temporary')).toBe(0);
    expect(after(item, 'resources.ward.current')).toBe(3);
    expect(item.overflow).toBeUndefined();
  });

  test('apply_damage: a negative result is no effect, never a heal', () => {
    const { item } = one(
      { effect: 'apply_damage', params: { resource: 'ward', amount: { formula: '1 - 4' } } },
      state({ resources: { ward: POOL(2) } }),
    );
    expect(item.status).toBe('no_effect');
    expect(item.operations).toEqual([]);
  });

  test('heal and gain clamp at the declared maximum', () => {
    for (const effect of ['heal', 'gain_resource']) {
      const { item } = one(
        { effect, params: { resource: 'ward', amount: 9 } },
        state({ resources: { ward: POOL(4) } }),
      );
      expect(after(item, 'resources.ward.current')).toBe(5);
    }
  });

  test('gain_resource can add temporary points, only to a pool declaring them', () => {
    const { item } = one(
      { effect: 'gain_resource', params: { resource: 'ward', amount: 2, temporary: true } },
      state({ resources: { ward: POOL(1) } }),
    );
    expect(after(item, 'resources.ward.temporary')).toBe(2);
    const refused = one({
      effect: 'gain_resource',
      params: { resource: 'luck', amount: 2, temporary: true },
    }).item;
    expect([refused.status, refused.reason]).toEqual(['refused', 'no_temporary_pool']);
  });

  test('a maximum can be a formula over the target itself', () => {
    const { item } = one(
      { effect: 'heal', params: { resource: 'guard', amount: 99 } },
      state({ fields: { level: 2 }, resources: { guard: POOL(1) } }),
    );
    expect(after(item, 'resources.guard.current')).toBe(5);
  });

  test('spend_resource is guarded; spending what is not there is refused', () => {
    const { item } = one(
      { effect: 'spend_resource', params: { resource: 'luck', amount: 1 } },
      state({ resources: { luck: POOL(1) } }),
    );
    expect(item.operations[0]?.requires).toEqual({ path: 'resources.luck.current', atLeast: 1 });
    const short = one(
      { effect: 'spend_resource', params: { resource: 'luck', amount: 2 } },
      state({ resources: { luck: POOL(1) } }),
    );
    expect([short.item.status, short.item.reason]).toEqual(['refused', 'insufficient']);
    expect(resolvePlan(short.basis, short.plan)).toEqual({
      ok: false,
      error: { code: 'item_refused', subject: '0' },
    });
  });

  test('modify_field: a delta clamped to the field, or a set on a non-numeric one', () => {
    const numeric = one(
      { effect: 'modify_field', params: { field: 'BRAWN', amount: -5 } },
      state({ fields: { BRAWN: 3 } }),
    ).item;
    expect(numeric.operations.map(({ operation }) => operation.op)).toEqual(['delta', 'clamp']);
    expect(after(numeric, 'fields.BRAWN')).toBe(0);
    const text = one({ effect: 'modify_field', params: { field: 'title', value: 'Ser' } }).item;
    expect(text.operations[0]?.operation).toEqual({
      op: 'set',
      path: 'fields.title',
      value: 'Ser',
    });
  });

  test('conditions: count stacks, single does not, removal stops at 0', () => {
    const count = one(
      { effect: 'add_condition', params: { condition: 'fatigue' } },
      state({ conditions: { fatigue: 2 } }),
    ).item;
    expect(after(count, 'conditions.fatigue')).toBe(3);
    const single = one({ effect: 'add_condition', params: { condition: 'stunned' } }).item;
    expect(single.operations.map(({ operation }) => operation.op)).toEqual(['delta', 'clamp']);
    expect(after(single, 'conditions.stunned')).toBe(1);
    const already = one(
      { effect: 'add_condition', params: { condition: 'stunned' } },
      state({ conditions: { stunned: 1 } }),
    ).item;
    expect(already.status).toBe('no_effect');
    const removed = one(
      { effect: 'remove_condition', params: { condition: 'fatigue' } },
      state({ conditions: { fatigue: 1 } }),
    ).item;
    expect(after(removed, 'conditions.fatigue')).toBe(0);
    expect(one({ effect: 'remove_condition', params: { condition: 'fatigue' } }).item.status).toBe(
      'no_effect',
    );
  });

  test('boxes: first free by default, a named one when given, guarded; a full track refuses', () => {
    const first = one({ effect: 'mark_box', params: { resource: 'strain' } }).item;
    expect(first.operations[0]).toEqual({
      operation: { op: 'set', path: 'tracks.strain.one', value: true },
      requires: { path: 'tracks.strain.one', equals: false },
    });
    const named = one({ effect: 'mark_box', params: { resource: 'strain', box: 'two' } }).item;
    expect(after(named, 'tracks.strain.two')).toBe(true);
    const full = one(
      { effect: 'mark_box', params: { resource: 'strain' } },
      state({ tracks: { strain: { one: true, two: true } } }),
    ).item;
    expect([full.status, full.reason]).toEqual(['refused', 'track_full']);
    const cleared = one(
      { effect: 'clear_box', params: { resource: 'strain', box: 'one' } },
      state({ tracks: { strain: { one: true } } }),
    ).item;
    expect(after(cleared, 'tracks.strain.one')).toBe(false);
  });

  test('slots: need a slot and text, are guarded by empty, and refuse when filled', () => {
    const effect = { effect: 'fill_slot', params: { field: 'harm', slot: 'mild' } };
    const pending = one(effect);
    expect([pending.item.status, pending.item.reason]).toEqual(['needs_input', 'text']);
    expect(resolvePlan(pending.basis, pending.plan)).toEqual({
      ok: false,
      error: { code: 'needs_input', subject: 'text' },
    });
    const resolved = resolvePlan(pending.basis, pending.plan, {
      selections: { text: 'Broken arm' },
    });
    expect(resolved.ok && resolved.value.operations[0]).toEqual({
      operation: { op: 'set', path: 'slots.harm.mild', value: 'Broken arm' },
      requires: { path: 'slots.harm.mild', equals: '' },
    });
    const filled = one(effect, state({ slots: { harm: { mild: 'Old' } } })).item;
    expect([filled.status, filled.reason]).toEqual(['refused', 'slot_filled']);
    const cleared = one(
      { effect: 'clear_slot', params: { field: 'harm', slot: 'mild' } },
      state({ slots: { harm: { mild: 'Old' } } }),
    ).item;
    expect(after(cleared, 'slots.harm.mild')).toBe('');
  });

  test('inventory: moves an item, and over capacity is a warning for the table', () => {
    const effect = { effect: 'move_inventory_item', params: { inventory: 'pack' } };
    const pending = one(effect);
    expect(pending.item.status).toBe('needs_input');
    const moved = resolvePlan(pending.basis, pending.plan, {
      selections: { item: 'rope', slot: 3 },
    });
    expect(moved.ok && moved.value.operations[0]?.operation).toEqual({
      op: 'set',
      path: 'inventory.pack.rope.slot',
      value: 3,
    });
    const over = one({
      effect: 'move_inventory_item',
      params: { inventory: 'pack', item: 'rope', slot: 10 },
    }).item;
    expect(over.warnings).toEqual(['over_capacity']);
    expect(over.status).toBe('ready');
  });

  test('execute_roll returns the action to run next and changes nothing', () => {
    const {
      plan: planned,
      basis,
      item,
    } = one({ effect: 'execute_roll', params: { action: 'act' } });
    expect([item.status, item.followUp]).toEqual(['follow_up', 'act']);
    const resolved = resolvePlan(basis, planned);
    expect(resolved.ok && resolved.value.followUps).toEqual(['act']);
    expect(resolved.ok && resolved.value.operations).toEqual([]);
  });

  test.each(['advance_clock', 'trigger_event', 'reveal_knowledge'])(
    '%s is declared, marked unsupported, and refused unless declined',
    (effect) => {
      expect(checkEffectKind(effect)).toBeUndefined();
      const { plan: planned, basis, item } = one({ effect, params: { anything: 'goes' } });
      expect(item.status).toBe('unsupported');
      expect(resolvePlan(basis, planned)).toEqual({
        ok: false,
        error: { code: 'unsupported_effect', subject: effect },
      });
      expect(resolvePlan(basis, planned, { items: { 0: 'decline' } })).toEqual({
        ok: false,
        error: { code: 'nothing_to_apply' },
      });
    },
  );

  test('no numeric kind ever emits a set', () => {
    const effects: Effect[] = [
      { effect: 'apply_damage', params: { resource: 'ward', amount: 1 } },
      { effect: 'heal', params: { resource: 'ward', amount: 1 } },
      { effect: 'gain_resource', params: { resource: 'ward', amount: 1 } },
      { effect: 'spend_resource', params: { resource: 'luck', amount: 1 } },
      { effect: 'modify_field', params: { field: 'BRAWN', amount: 1 } },
      { effect: 'add_condition', params: { condition: 'fatigue' } },
      { effect: 'add_condition', params: { condition: 'stunned' } },
      { effect: 'remove_condition', params: { condition: 'fatigue' } },
    ];
    for (const effect of effects) {
      const { item } = one(
        effect,
        state({
          fields: { BRAWN: 2 },
          resources: { ward: POOL(2), luck: POOL(2) },
          conditions: { fatigue: 1 },
        }),
      );
      expect(item.operations.length).toBeGreaterThan(0);
      expect(item.operations.filter(({ operation }) => operation.op === 'set')).toEqual([]);
    }
  });
});

describe('plans', () => {
  test('several effects on one resource apply in declared order', () => {
    const planned = plan(
      withEffects([
        { effect: 'apply_damage', params: { resource: 'ward', amount: 3 } },
        { effect: 'heal', params: { resource: 'ward', amount: 2 } },
      ]),
      state({ resources: { ward: POOL(4) } }),
    );
    expect(planned.plan.items.map((item) => after(item, 'resources.ward.current'))).toEqual([1, 3]);
    const resolved = resolvePlan(planned.basis, planned.plan);
    expect(resolved.ok && resolved.value.changes).toEqual([
      { path: 'resources.ward.current', before: 4, after: 3 },
    ]);
  });

  test('planning writes nothing: state objects are untouched', () => {
    const target = state({ resources: { ward: POOL(4) } });
    const copy = structuredClone(target);
    const planned = plan(
      withEffects([{ effect: 'heal', params: { resource: 'ward', amount: 1 } }]),
      target,
    );
    resolvePlan(planned.basis, planned.plan);
    expect(target).toEqual(copy);
  });

  test('declining everything is nothing to apply; declining one keeps the other', () => {
    const planned = plan(
      withEffects([
        { effect: 'heal', params: { resource: 'ward', amount: 1 } },
        { effect: 'add_condition', params: { condition: 'fatigue' } },
      ]),
      state({ resources: { ward: POOL(1) } }),
    );
    expect(
      resolvePlan(planned.basis, planned.plan, { items: { 0: 'decline', 1: 'decline' } }),
    ).toEqual({
      ok: false,
      error: { code: 'nothing_to_apply' },
    });
    const partial = resolvePlan(planned.basis, planned.plan, { items: { 1: 'decline' } });
    expect(partial.ok && partial.value.changes.map((change) => change.path)).toEqual([
      'resources.ward.current',
    ]);
    expect(partial.ok && partial.value.edited).toBe(false);
  });

  test('an edit recomputes from the new amount and is marked', () => {
    const planned = plan(
      withEffects([
        { effect: 'apply_damage', params: { resource: 'ward', amount: 1 } },
        { effect: 'add_condition', params: { condition: 'fatigue' } },
      ]),
      state({ resources: { ward: POOL(5) } }),
    );
    const edited = resolvePlan(planned.basis, planned.plan, {
      items: { 0: { amount: 4 }, 1: 'decline' },
    });
    expect(edited.ok && edited.value.edited).toBe(true);
    expect(edited.ok && edited.value.changes).toEqual([
      { path: 'resources.ward.current', before: 5, after: 1 },
    ]);
  });

  test('a decision naming an item that does not exist, or a bad amount, is refused', () => {
    const planned = one({ effect: 'heal', params: { resource: 'ward', amount: 1 } });
    expect(resolvePlan(planned.basis, planned.plan, { items: { 7: 'decline' } })).toEqual({
      ok: false,
      error: { code: 'unknown_item', subject: '7' },
    });
    expect(resolvePlan(planned.basis, planned.plan, { items: { 0: { amount: 1.5 } } })).toEqual({
      ok: false,
      error: { code: 'invalid_amount', subject: '0' },
    });
  });
});

describe('the two paradigms, end to end, with no system conditional', () => {
  const skills = { fight: { skill: 'Fight', rating: 3 } };

  test('roll-under: a pick, then success from the declaration', () => {
    const system = slotSystem();
    const target = state({ fields: { BRAWN: 11 } });
    const prepared = prepareAction(system, 'save', target, { picks: { attribute: 'BRAWN' } });
    if (!prepared.ok) throw new Error(prepared.error.code);
    expect(prepared.value.rollRequest?.expression).toBe('1d20');
    const atThreshold = planOutcome(prepared.value, rollOf(11));
    expect(atThreshold.ok && atThreshold.value.success).toBe(true);
    const over = planOutcome(prepared.value, rollOf(12));
    expect(over.ok && over.value.success).toBe(false);
  });

  test('protection that gives way: absorbed, then spilling, by declared outcome', () => {
    const system = slotSystem();
    const target = state({
      fields: { armor: 1, BRAWN: 10, level: 2 },
      resources: { guard: POOL(4) },
    });
    const prepared = prepareAction(system, 'take_damage', target);
    if (!prepared.ok) throw new Error(prepared.error.code);
    const absorbed = planOutcome(prepared.value, rollOf(3));
    if (!absorbed.ok) throw new Error(absorbed.error.code);
    expect(absorbed.value.outcome?.id).toBe('absorbed');
    expect(absorbed.value.items[0]?.changes).toEqual([
      { path: 'resources.guard.current', before: 4, after: 2 },
    ]);
    const spills = planOutcome(prepared.value, rollOf(6));
    if (!spills.ok) throw new Error(spills.error.code);
    expect(spills.value.outcome?.id).toBe('spills');
    const resolved = resolvePlan(prepared.value, spills.value);
    expect(resolved.ok && resolved.value.changes).toEqual([
      { path: 'fields.BRAWN', before: 10, after: 9 },
    ]);
    expect(resolved.ok && resolved.value.followUps).toEqual(['save']);
  });

  test('roll plus skill: a repeater pick, a prompt, a derived margin, and the table choosing', () => {
    const system = aspectSystem();
    const target = state({ entries: { skills } });
    const prepared = prepareAction(system, 'attack', target, {
      picks: { skill: { field: 'skills', entry: 'fight' } },
      prompts: { opposition: 2 },
    });
    if (!prepared.ok) throw new Error(prepared.error.code);
    expect(prepared.value.rollRequest).toEqual({
      expression: '4dF + skill',
      inputs: { skill: 3, opposition: 2 },
    });
    const hit = planOutcome(prepared.value, rollOf(4, 1));
    if (!hit.ok) throw new Error(hit.error.code);
    expect(hit.value.values.margin).toBe(2);
    expect(hit.value.mode).toBe('choice');
    expect(hit.value.options.map((option) => option.id)).toEqual([
      'mark_box',
      'take_harm',
      'concede',
    ]);
    // Nothing applies on the table's behalf.
    expect(resolvePlan(prepared.value, hit.value)).toEqual({
      ok: false,
      error: { code: 'choice_required' },
    });
    expect(resolvePlan(prepared.value, hit.value, { option: 'other' })).toEqual({
      ok: false,
      error: { code: 'unknown_option', subject: 'other' },
    });
    const marked = resolvePlan(prepared.value, hit.value, { option: 'mark_box' });
    expect(marked.ok && marked.value.changes).toEqual([
      { path: 'tracks.strain.one', before: false, after: true },
    ]);
    const harm = resolvePlan(prepared.value, hit.value, {
      option: 'take_harm',
      selections: { slot: 'mild', text: 'Bruised ribs' },
    });
    expect(harm.ok && harm.value.changes).toEqual([
      { path: 'slots.lasting_harm.mild', before: '', after: 'Bruised ribs' },
    ]);
    expect(resolvePlan(prepared.value, hit.value, { option: 'concede' })).toEqual({
      ok: false,
      error: { code: 'nothing_to_apply' },
    });
    const miss = planOutcome(prepared.value, rollOf(2, -1));
    expect(miss.ok && miss.value.outcome?.id).toBe('miss');
  });

  test.each<[string, string, Parameters<typeof prepareAction>[3], string]>([
    ['an unknown action', 'nope', {}, 'unknown_action'],
    ['a pick left out', 'save', {}, 'missing_pick'],
    ['a pick outside its fields', 'save', { picks: { attribute: 'armor' } }, 'invalid_pick'],
  ])('%s cannot be prepared', (_name, key, selections, code) => {
    const prepared = prepareAction(slotSystem(), key, state(), selections);
    expect(prepared.ok ? undefined : prepared.error.code).toBe(code as never);
  });

  test('a repeater pick needs an entry that exists', () => {
    const prepare = (picks: Record<string, unknown>) =>
      prepareAction(aspectSystem(), 'attack', state({ entries: { skills } }), {
        picks: picks as never,
      });
    expect(prepare({ skill: 'skills' })).toMatchObject({
      ok: false,
      error: { code: 'invalid_pick' },
    });
    expect(prepare({ skill: { field: 'skills', entry: 'none' } })).toMatchObject({
      ok: false,
      error: { code: 'invalid_pick' },
    });
  });

  test('a prompt with no default must be entered', () => {
    const system = structuredClone(aspectSystem()) as unknown as {
      actions: { prompts: Record<string, unknown>[] }[];
    };
    (system.actions[0] as { prompts: Record<string, unknown>[] }).prompts = [
      { name: 'opposition', label: 'Opposition' },
    ];
    const prepared = prepareAction(
      system as unknown as SystemPackage,
      'attack',
      state({ entries: { skills } }),
      { picks: { skill: { field: 'skills', entry: 'fight' } } },
    );
    expect(prepared).toMatchObject({ ok: false, error: { code: 'missing_prompt' } });
  });

  test('a formula reads only what the action declares', () => {
    const system = structuredClone(slotSystem()) as unknown as {
      actions: { inputs: string[] }[];
    };
    (system.actions[1] as { inputs: string[] }).inputs = ['BRAWN'];
    const prepared = prepareAction(
      system as unknown as SystemPackage,
      'take_damage',
      state({ fields: { armor: 1 } }),
    );
    if (!prepared.ok) throw new Error(prepared.error.code);
    expect(planOutcome(prepared.value, rollOf(3))).toMatchObject({
      ok: false,
      error: { code: 'unknown_identifier' },
    });
  });
});

describe('recovery and bounds', () => {
  test('recovery follows the rule: an amount, or back to the maximum, and clears boxes', () => {
    const system = testSystem();
    const target = state({
      fields: { level: 1 },
      resources: { guard: POOL(0), ward: POOL(1) },
      tracks: { strain: { one: true } },
    });
    const dawn = planRecovery(system, target, 'dawn');
    if (!dawn.ok) throw new Error(dawn.error.code);
    const resolved = resolvePlan({ system, state: target }, dawn.value);
    expect(resolved.ok && resolved.value.changes).toEqual([
      { path: 'resources.ward.current', before: 1, after: 3 },
      { path: 'tracks.strain.one', before: true, after: false },
    ]);
    const rest = planRecovery(system, target, 'short_rest');
    expect(rest.ok && rest.value.items[0]?.changes).toEqual([
      { path: 'resources.guard.current', before: 0, after: 4 },
    ]);
    const nothing = planRecovery(system, target, 'never');
    expect(nothing.ok && nothing.value.mode).toBe('none');
  });

  test('declared bounds are re-applied to any state', () => {
    const clamped = clampTargetState(
      testSystem(),
      state({
        fields: { level: 1, BRAWN: 99 },
        resources: { guard: POOL(99), ward: POOL(-3) },
      }),
    );
    expect(clamped.resources.guard?.current).toBe(4);
    expect(clamped.resources.ward?.current).toBe(0);
    expect(clamped.fields.BRAWN).toBe(18);
  });
});

describe('what a viewer sees', () => {
  test('a GM-only subject keeps its place without its numbers, for a player only', () => {
    const system = withEffects([
      { effect: 'spend_resource', params: { resource: 'luck', amount: 1 } },
      { effect: 'heal', params: { resource: 'ward', amount: 1 } },
    ]);
    const { plan: planned } = plan(system, state({ resources: { luck: POOL(3), ward: POOL(1) } }));
    const player = visiblePlan(planned, system, false);
    expect(player.items[0]).toEqual({
      index: 0,
      kind: 'spend_resource',
      status: 'hidden',
      operations: [],
      changes: [],
    });
    expect(player.items[1]?.status).toBe('ready');
    expect(player.values).toEqual({});
    expect(JSON.stringify(player)).not.toContain('resources.luck');
    expect(visiblePlan(planned, system, true)).toBe(planned);
    expect(touchesGmOnly(system, planned.items[0]?.operations ?? [])).toBe(true);
    expect(touchesGmOnly(system, planned.items[1]?.operations ?? [])).toBe(false);
  });
});

describe('package rules', () => {
  const issues = (effect: Effect) =>
    checkSystemEffects(withEffects([effect])).map((issue) => issue.path);
  const PATH = '/actions/0/outcomes/0/resolution/effects/0';

  test('both paradigms and every kind in use are clean', () => {
    expect(checkSystemEffects(slotSystem())).toEqual([]);
    expect(checkSystemEffects(aspectSystem())).toEqual([]);
    expect(checkEffectKind('adjust_resource')).toContain('does not exist');
    expect(EFFECT_KINDS.size).toBe(16);
  });

  test.each<[string, Effect]>([
    ['a missing parameter', { effect: 'heal', params: { resource: 'ward' } }],
    ['an unknown parameter', { effect: 'heal', params: { resource: 'ward', amount: 1, x: 1 } }],
    ['an undeclared resource', { effect: 'heal', params: { resource: 'nope', amount: 1 } }],
    [
      'a track where a pool is needed',
      { effect: 'heal', params: { resource: 'strain', amount: 1 } },
    ],
    ['a pool where a track is needed', { effect: 'mark_box', params: { resource: 'ward' } }],
    ['a fractional amount', { effect: 'heal', params: { resource: 'ward', amount: 1.5 } }],
    ['an undeclared condition', { effect: 'add_condition', params: { condition: 'nope' } }],
    ['an undeclared field', { effect: 'modify_field', params: { field: 'nope', amount: 1 } }],
    [
      'both amount and value',
      { effect: 'modify_field', params: { field: 'BRAWN', amount: 1, value: 2 } },
    ],
    ['neither amount nor value', { effect: 'modify_field', params: { field: 'BRAWN' } }],
    ['an amount on text', { effect: 'modify_field', params: { field: 'title', amount: 1 } }],
    ['a value on a number', { effect: 'modify_field', params: { field: 'BRAWN', value: 1 } }],
    ['slots on a plain field', { effect: 'fill_slot', params: { field: 'title' } }],
    ['another inventory', { effect: 'move_inventory_item', params: { inventory: 'other' } }],
    ['an undeclared action', { effect: 'execute_roll', params: { action: 'nope' } }],
  ])('%s is refused with its path', (_name, effect) => {
    expect(issues(effect)).toContain(PATH);
  });

  test('a deferred kind loads, whatever its parameters', () => {
    expect(issues({ effect: 'advance_clock', params: { clock: 'doom', ticks: 1 } })).toEqual([]);
  });

  test('option effects are checked too', () => {
    const system = structuredClone(aspectSystem()) as unknown as {
      actions: { outcomes: { resolution: { options: { effects: Effect[] }[] } }[] }[];
    };
    const option = system.actions[0]?.outcomes[0]?.resolution.options[0];
    if (option === undefined) throw new Error('no option');
    option.effects = [{ effect: 'mark_box', params: { resource: 'nope' } }];
    expect(
      checkSystemEffects(system as unknown as SystemPackage).map((issue) => issue.path),
    ).toEqual(['/actions/0/outcomes/0/resolution/options/0/effects/0']);
  });
});

describe('purity', () => {
  test('the engine names no system, reads no clock, and reaches no host', () => {
    const directory = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
    const forbidden =
      /\b(eval|Function|globalThis|window|process|require|Date|Intl|fetch|setTimeout|localStorage|Bun|cairn|fate)\b|Math\.random|toLocale|import\(/;
    for (const name of readdirSync(directory)) {
      if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue;
      const code = readFileSync(join(directory, name), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      expect({ name, match: forbidden.exec(code)?.[0] }).toEqual({ name, match: undefined });
    }
  });
});
