import { describe, expect, test } from 'bun:test';
import { parseRoll } from '@rpg/dice/engine';
import { FIXTURE_SYSTEM_DEFINITION, FIXTURE_SYSTEM_PACKAGE } from '@rpg/fixtures';
import { compileFormula } from '@rpg/formula';
import { INSTALLED_SYSTEM_PACKAGES } from '@rpg/installed-systems';
import type { SystemPackage } from '@rpg/systems';
import { runConformance } from '@rpg/systems/testing';
import { aspectSystem, slotSystem } from '@rpg/systems/testing/paradigms';
import { createSystemRegistry, ENGINE_VALIDATORS, installedSystemDefinitions } from './registry.ts';

/**
 * Feature 09 and 10 at package load, with the real engines: FR-005 and FR-008 of each. Every
 * expression the two invented systems and the fixture declare must compile with no engine change
 * specific to any of them.
 */

function expressions(value: unknown): { dice: string[]; formula: string[] } {
  const found: { dice: string[]; formula: string[] } = { dice: [], formula: [] };
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (typeof node !== 'object' || node === null) return;
    for (const [key, nested] of Object.entries(node)) {
      if (key === 'dice' && typeof nested === 'string') found.dice.push(nested);
      else if (key === 'formula' && typeof nested === 'string') found.formula.push(nested);
      else walk(nested);
    }
  };
  walk(value);
  return found;
}

function mutable(): SystemPackage {
  return structuredClone(slotSystem()) as SystemPackage;
}

describe('the paradigm packages through the real engines', () => {
  test.each([
    ['slot', slotSystem()],
    ['aspect', aspectSystem()],
    ['fixture', FIXTURE_SYSTEM_PACKAGE],
  ] as const)('%s loads, and its conformance run with the engines passes', (_name, system) => {
    const loaded = createSystemRegistry().load(system);
    expect(loaded.ok ? [] : loaded.error).toEqual([]);
    const report = runConformance(system, ENGINE_VALIDATORS);
    expect(report.checks.filter((check) => !check.passed)).toEqual([]);
  });

  test('every declared expression is exercised, including the named input', () => {
    const slot = expressions(slotSystem());
    const aspect = expressions(aspectSystem());
    expect(aspect.dice).toEqual(['4dF + skill']);
    expect(slot.dice.sort()).toEqual(['1d20', '1d6']);
    expect(slot.formula.sort()).toEqual([
      'level + 3',
      'roll - armor',
      'roll - armor <= guard',
      'roll <= attribute',
    ]);
    expect(aspect.formula.sort()).toEqual(['margin > 0', 'roll - opposition']);
    const parsed = parseRoll('4dF + skill');
    expect(parsed.ok && parsed.value.inputs).toEqual(['skill']);
    for (const source of [...slot.formula, ...aspect.formula]) {
      expect(compileFormula(source).ok).toBe(true);
    }
  });
});

describe('a bad expression refuses the whole package', () => {
  test('a dice expression the engine rejects, with its path', () => {
    const system = mutable();
    const action = system.actions[0] as { roll: { dice: string } };
    action.roll.dice = '1d7';
    const loaded = createSystemRegistry().load(system);
    expect(loaded.ok ? [] : loaded.error).toEqual([
      {
        code: 'invalid_expression',
        path: '/actions/0/roll',
        message: 'unknown_die: The die d7 is not supported.',
      },
    ]);
  });

  test('a formula the engine rejects, inside an effect parameter', () => {
    const system = JSON.parse(
      JSON.stringify(slotSystem()).replace('"roll - armor"', '"eval(armor)"'),
    ) as SystemPackage;
    const loaded = createSystemRegistry().load(system);
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.error.map((error) => error.code)).toEqual(['invalid_expression']);
    expect(loaded.error[0]?.path).toContain('/params/amount');
    expect(loaded.error[0]?.message).toStartWith('unknown_function:');
    expect(createSystemRegistry().resolve(system.manifest.ref)).toBeUndefined();
  });

  test('computed fields that read each other are a cycle', () => {
    const system = mutable() as unknown as {
      characterSchema: { fields: unknown[] };
    } & SystemPackage;
    system.characterSchema.fields.push(
      {
        key: 'first',
        label: 'First',
        group: 'status',
        type: 'computed',
        value: { formula: 'second + 1' },
      },
      {
        key: 'second',
        label: 'Second',
        group: 'status',
        type: 'computed',
        value: { formula: 'first + 1' },
      },
    );
    const loaded = createSystemRegistry().load(system);
    expect(loaded.ok ? [] : loaded.error).toEqual([
      {
        code: 'formula_cycle',
        path: `/characterSchema/fields/${system.characterSchema.fields.length - 2}/value`,
        message: 'These formulas read each other: first, second.',
      },
    ]);
  });

  test('a resource maximum in a cycle with a computed field is refused', () => {
    const system = mutable() as unknown as {
      characterSchema: { fields: unknown[] };
      resources: { max: unknown }[];
    } & SystemPackage;
    system.characterSchema.fields.push({
      key: 'bonus',
      label: 'Bonus',
      group: 'status',
      type: 'computed',
      value: { formula: 'guard + 1' },
    });
    (system.resources[0] as { max: unknown }).max = { formula: 'bonus + 3' };
    const loaded = createSystemRegistry().load(system);
    expect(loaded.ok ? [] : loaded.error.map((error) => error.code)).toEqual(['formula_cycle']);
  });

  test('computed fields that read an input are not a cycle', () => {
    const system = mutable() as unknown as {
      characterSchema: { fields: unknown[] };
    } & SystemPackage;
    system.characterSchema.fields.push({
      key: 'carry',
      label: 'Carry',
      group: 'status',
      type: 'computed',
      value: { formula: 'BRAWN * 2' },
    });
    expect(createSystemRegistry().load(system).ok).toBe(true);
  });

  test('a bad expression also fails the kit that features 12 and 13 run', () => {
    const system = mutable();
    (system.actions[0] as { roll: { dice: string } }).roll.dice = '1d7';
    const report = runConformance(system, ENGINE_VALIDATORS);
    expect(report.passed).toBe(false);
    expect(report.checks.find((check) => check.name === 'expressions are valid')?.passed).toBe(
      false,
    );
    expect(
      runConformance(system).checks.find((c) => c.name === 'expressions are valid')?.passed,
    ).toBe(true);
  });
});

describe('the served catalog', () => {
  test('the installed fixture is unchanged through the validated registry', () => {
    expect(installedSystemDefinitions([FIXTURE_SYSTEM_PACKAGE])).toEqual([
      FIXTURE_SYSTEM_DEFINITION,
    ]);
  });

  test('every shipped package loads, with no package left behind', () => {
    const served = installedSystemDefinitions().map(
      (definition) => definition.summary.ref.systemId,
    );
    expect(served.length).toBe(INSTALLED_SYSTEM_PACKAGES.length + 1);
    expect(new Set(served).size).toBe(served.length);
  });

  test('a rejected package is not served and does not take the others down', () => {
    const broken = mutable();
    (broken.actions[0] as { roll: { dice: string } }).roll.dice = 'not dice';
    const definitions = installedSystemDefinitions([broken, FIXTURE_SYSTEM_PACKAGE]);
    expect(definitions).toEqual([FIXTURE_SYSTEM_DEFINITION]);
  });
});
