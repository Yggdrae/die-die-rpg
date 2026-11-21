import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  checkEffectKind,
  checkSystemEffects,
  EMPTY_TARGET_STATE,
  planOutcome,
  planRecovery,
  prepareAction,
  resolvePlan,
  type TargetState,
} from '@rpg/actions/engine';
import {
  checkDiceSource,
  evaluateRoll,
  parseRoll,
  type RollResult,
  seededRandom,
} from '@rpg/dice/engine';
import { checkFormulaCycles, checkFormulaSource } from '@rpg/formula';
import { type ExpressionValidators, loadSystemPackage, type SystemPackage } from '@rpg/systems';
import { runConformance } from '@rpg/systems/testing';
import { INSTALLED_SYSTEM_PACKAGES } from './index.ts';

/**
 * Features 12 and 13: both real packages through the real engines, each mechanic the PRDs name, played end
 * to end through the same pipeline. No engine or generic code knows either system (`PRD.md` s.89).
 */

const VALIDATORS: ExpressionValidators = {
  dice: checkDiceSource,
  formula: checkFormulaSource,
  formulaCycles: checkFormulaCycles,
  effect: checkEffectKind,
  effects: checkSystemEffects,
};

function installed(systemId: string): SystemPackage {
  const candidate = INSTALLED_SYSTEM_PACKAGES.find(
    (item) => (item as SystemPackage).manifest.ref.systemId === systemId,
  );
  const loaded = loadSystemPackage(candidate, VALIDATORS);
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.error));
  return loaded.value;
}

function rollOf(modified: number, natural = modified): RollResult {
  return {
    terms: [{ kind: 'modifier', sign: 1, value: 0 }],
    natural,
    modified,
  };
}

function state(overrides: Partial<TargetState>): TargetState {
  return { ...EMPTY_TARGET_STATE, ...overrides };
}

describe.each(
  INSTALLED_SYSTEM_PACKAGES.map((item) => [(item as SystemPackage).manifest.name, item] as const),
)('%s', (_name, candidate) => {
  test('passes the conformance kit with every engine, with no exception', () => {
    const report = runConformance(candidate, VALIDATORS);
    expect(report.checks.filter((check) => !check.passed)).toEqual([]);
    expect(report.passed).toBe(true);
  });

  test('its integration status is honest: mechanics yes, rules text and compendium no', () => {
    const { manifest, rules, capabilities } = candidate as SystemPackage;
    expect(manifest.integration.mechanicsSupported).toBe(true);
    expect(manifest.integration.rulesTextIntegrated).toBe(false);
    expect(manifest.integration.compendiumIntegrated).toBe(false);
    expect(manifest.integration.externalDocumentation).toStartWith('https://');
    expect(rules.sections.every((section) => section.body === undefined)).toBe(true);
    expect(capabilities).not.toContain('integrated_rules');
  });

  test('it ships no artwork or logo, and carries its attribution', () => {
    const { license } = (candidate as SystemPackage).manifest;
    expect(license.assets.officialArtwork).toBe('forbidden');
    expect(license.assets.officialLogo).toBe('forbidden');
    expect(license.attribution.length).toBeGreaterThan(40);
    expect(license.license).toMatch(/^CC BY/);
  });

  test('every action prepares and plans through the pipeline, for every outcome reachable', () => {
    const system = candidate as SystemPackage;
    const target = state({
      fields: {
        STR: 10,
        DEX: 10,
        WIL: 10,
        armor: 1,
        hp_max: 4,
        refresh: 3,
      },
      resources: { hp: { current: 4 }, fate_points: { current: 2 } },
      entries: { skills: { fight: { skill: 'Fight', rating: 2 } } },
    });
    for (const action of system.actions) {
      const picks = Object.fromEntries(
        (action.picks ?? []).map((pick) => [
          pick.name,
          pick.entryField === undefined
            ? (pick.fields[0] as string)
            : { field: pick.fields[0] as string, entry: 'fight' },
        ]),
      );
      const prepared = prepareAction(system, action.key, target, { picks });
      if (!prepared.ok) throw new Error(`${action.key}: ${JSON.stringify(prepared.error)}`);
      let roll: RollResult | undefined;
      if (prepared.value.rollRequest !== undefined) {
        const parsed = parseRoll(prepared.value.rollRequest.expression);
        if (!parsed.ok) throw new Error(action.key);
        const rolled = evaluateRoll(
          parsed.value,
          prepared.value.rollRequest.inputs ?? {},
          seededRandom(7),
        );
        if (!rolled.ok) throw new Error(`${action.key}: ${rolled.error.code}`);
        roll = rolled.value;
      }
      const planned = planOutcome(prepared.value, roll);
      expect({ action: action.key, ok: planned.ok }).toEqual({ action: action.key, ok: true });
    }
  });

  test('it is declarations only: the package directory holds one JSON file', () => {
    const system = (candidate as SystemPackage).manifest.ref.systemId;
    const directory = join(
      new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
      system,
    );
    expect(readdirSync(directory)).toEqual(['system.json']);
    const text = readFileSync(join(directory, 'system.json'), 'utf8');
    expect(() => JSON.parse(text)).not.toThrow();
  });
});

describe('Cairn: saves', () => {
  const system = installed('cairn-2e');
  const target = state({ fields: { STR: 11, DEX: 8, WIL: 13 } });
  const save = (natural: number) => {
    const prepared = prepareAction(system, 'save', target, { picks: { attribute: 'STR' } });
    if (!prepared.ok) throw new Error(prepared.error.code);
    const planned = planOutcome(prepared.value, rollOf(natural));
    return planned.ok ? planned.value.outcome?.id : undefined;
  };

  test.each([
    [1, 'natural_one'],
    [11, 'success'],
    [12, 'failure'],
    [20, 'natural_twenty'],
  ])('rolling %i against 11 is %s', (natural, outcome) => {
    expect(save(natural)).toBe(outcome);
  });

  test('a 1 succeeds even against a very low attribute, and a 20 fails against a very high one', () => {
    const low = prepareAction(system, 'save', state({ fields: { DEX: 0 } }), {
      picks: { attribute: 'DEX' },
    });
    const high = prepareAction(system, 'save', state({ fields: { WIL: 25 } }), {
      picks: { attribute: 'WIL' },
    });
    if (!low.ok || !high.ok) throw new Error('prepare');
    const one = planOutcome(low.value, rollOf(1));
    const twenty = planOutcome(high.value, rollOf(20));
    expect(one.ok && one.value.outcome?.id).toBe('natural_one');
    expect(twenty.ok && twenty.value.outcome?.id).toBe('natural_twenty');
  });
});

describe('Cairn: damage reduces HP, then Strength', () => {
  const system = installed('cairn-2e');
  const target = (hp: number, armor: number, STR = 10) =>
    state({ fields: { STR, armor, hp_max: 6 }, resources: { hp: { current: hp } } });
  const take = (base: TargetState, roll: number) => {
    const prepared = prepareAction(system, 'take_damage_d6', base);
    if (!prepared.ok) throw new Error(prepared.error.code);
    const planned = planOutcome(prepared.value, rollOf(roll));
    if (!planned.ok) throw new Error(planned.error.code);
    const resolved = resolvePlan(prepared.value, planned.value);
    return { planned: planned.value, resolved };
  };

  test('armor stops damage at or below it', () => {
    const { planned, resolved } = take(target(4, 2), 2);
    expect(planned.outcome?.id).toBe('deflected');
    expect(resolved).toEqual({ ok: false, error: { code: 'nothing_to_apply' } });
  });

  test('HP absorbs what is left', () => {
    const { planned, resolved } = take(target(5, 1), 3);
    expect(planned.outcome?.id).toBe('absorbed');
    expect(resolved.ok && resolved.value.changes).toEqual([
      { path: 'resources.hp.current', before: 5, after: 3 },
    ]);
  });

  test('exactly to 0 HP is a scar', () => {
    const { planned, resolved } = take(target(2, 1), 3);
    expect(planned.outcome?.id).toBe('scar');
    expect(resolved.ok && resolved.value.changes).toEqual([
      { path: 'resources.hp.current', before: 2, after: 0 },
      { path: 'conditions.scar', before: 0, after: 1 },
    ]);
  });

  test('past 0 goes to Strength, then asks for the critical damage save', () => {
    const { planned, resolved } = take(target(1, 0), 4);
    expect(planned.outcome?.id).toBe('spills');
    expect(resolved.ok && resolved.value.changes).toEqual([
      { path: 'resources.hp.current', before: 1, after: 0 },
      { path: 'fields.STR', before: 10, after: 7 },
    ]);
    expect(resolved.ok && resolved.value.followUps).toEqual(['critical_damage_save']);
  });

  test('Strength reaching 0 is death', () => {
    const { planned, resolved } = take(target(1, 0, 2), 5);
    expect(planned.outcome?.id).toBe('fatal');
    expect(resolved.ok && resolved.value.changes.at(-1)).toEqual({
      path: 'conditions.dead',
      before: 0,
      after: 1,
    });
  });

  test('armor counts for no more than 3, whatever the sheet holds', () => {
    const { planned } = take(target(6, 9), 4);
    expect(planned.outcome?.id).toBe('absorbed');
  });

  test('failing the critical damage save marks it', () => {
    const prepared = prepareAction(system, 'critical_damage_save', target(0, 0, 7));
    if (!prepared.ok) throw new Error(prepared.error.code);
    const planned = planOutcome(prepared.value, rollOf(15));
    if (!planned.ok) throw new Error(planned.error.code);
    const resolved = resolvePlan(prepared.value, planned.value);
    expect(resolved.ok && resolved.value.changes).toEqual([
      { path: 'conditions.critical_damage', before: 0, after: 1 },
    ]);
  });

  test('a brief rest restores HP to its maximum', () => {
    const base = target(1, 0);
    const rest = planRecovery(system, base, 'brief_rest');
    if (!rest.ok) throw new Error(rest.error.code);
    const resolved = resolvePlan({ system, state: base }, rest.value);
    expect(resolved.ok && resolved.value.changes).toEqual([
      { path: 'resources.hp.current', before: 1, after: 6 },
    ]);
  });
});

describe('Cairn: fatigue, slots, spellbooks', () => {
  const system = installed('cairn-2e');

  test('fatigue is a counting condition that occupies a slot', () => {
    const fatigue = system.mechanics.conditions.find((item) => item.key === 'fatigue');
    expect([fatigue?.stacking, fatigue?.occupiesSlots]).toEqual(['count', 1]);
    expect(system.mechanics.inventory?.capacity).toBe(10);
  });

  test('casting from a spellbook adds fatigue, with no roll', () => {
    const prepared = prepareAction(system, 'cast_spell', state({ conditions: { fatigue: 1 } }));
    if (!prepared.ok) throw new Error(prepared.error.code);
    expect(prepared.value.rollRequest).toBeUndefined();
    const planned = planOutcome(prepared.value);
    if (!planned.ok) throw new Error(planned.error.code);
    const resolved = resolvePlan(prepared.value, planned.value);
    expect(resolved.ok && resolved.value.changes).toEqual([
      { path: 'conditions.fatigue', before: 1, after: 2 },
    ]);
  });
});

describe('Fate: the four actions read a margin', () => {
  const system = installed('fate-core');
  const target = state({ entries: { skills: { fight: { skill: 'Fight', rating: 3 } } } });
  const prepare = (key: string, opposition: number) => {
    const prepared = prepareAction(system, key, target, {
      picks: { skill: { field: 'skills', entry: 'fight' } },
      prompts: { opposition },
    });
    if (!prepared.ok) throw new Error(prepared.error.code);
    return prepared.value;
  };

  test.each(['overcome', 'create_advantage', 'attack', 'defend'])(
    '%s rolls four Fudge dice plus the skill, with degrees by shift',
    (key) => {
      const prepared = prepare(key, 2);
      expect(prepared.rollRequest).toEqual({
        expression: '4dF + skill',
        inputs: { skill: 3, opposition: 2 },
      });
      const outcome = (modified: number) => {
        const planned = planOutcome(prepared, rollOf(modified));
        return planned.ok ? planned.value.outcome?.id : undefined;
      };
      expect(outcome(5)).toBe('style');
      expect(outcome(4)).toBe('success');
      expect(outcome(3)).toBe('success');
      expect(outcome(2)).toBe('tie');
      expect(outcome(1)).toBe('failure');
    },
  );

  test('a hit offers stress, a consequence, or conceding, and applies none on its own', () => {
    const prepared = prepare('attack', 1);
    const planned = planOutcome(prepared, rollOf(3));
    if (!planned.ok) throw new Error(planned.error.code);
    expect(planned.value.mode).toBe('choice');
    expect(planned.value.options.map((option) => option.id)).toEqual([
      'physical_stress',
      'mental_stress',
      'consequence',
      'taken_out',
      'concede',
    ]);
    expect(resolvePlan(prepared, planned.value)).toEqual({
      ok: false,
      error: { code: 'choice_required' },
    });
  });

  test('stress is marked boxes, never a number', () => {
    const stress = system.resources.find((resource) => resource.key === 'physical_stress');
    expect(stress?.shape).toBe('track');
    const prepared = prepare('attack', 0);
    const planned = planOutcome(prepared, rollOf(2));
    if (!planned.ok) throw new Error(planned.error.code);
    const resolved = resolvePlan(prepared, planned.value, {
      option: 'physical_stress',
      selections: { box: 'two' },
    });
    expect(resolved.ok && resolved.value.changes).toEqual([
      { path: 'tracks.physical_stress.two', before: false, after: true },
    ]);
  });

  test('a consequence fills a severity slot with free text, and refuses a filled slot', () => {
    const consequences = system.characterSchema.fields.find(
      (field) => field.key === 'consequences',
    );
    expect(
      consequences?.type === 'repeater' && consequences.slots?.map((slot) => slot.severity),
    ).toEqual([2, 4, 6]);
    const prepared = prepare('attack', 0);
    const planned = planOutcome(prepared, rollOf(2));
    if (!planned.ok) throw new Error(planned.error.code);
    const decision = {
      option: 'consequence',
      selections: { slot: 'mild', text: 'Sprained ankle' },
    };
    const resolved = resolvePlan(prepared, planned.value, decision);
    expect(resolved.ok && resolved.value.changes).toEqual([
      { path: 'slots.consequences.mild', before: '', after: 'Sprained ankle' },
    ]);
    const filled = {
      ...prepared,
      state: state({ slots: { consequences: { mild: 'Old wound' } } }),
    };
    expect(resolvePlan(filled, planned.value, decision)).toEqual({
      ok: false,
      error: { code: 'item_refused', subject: '0' },
    });
  });

  test('aspects are typed free text, and skills name the ladder', () => {
    const fields = new Map(system.characterSchema.fields.map((field) => [field.key, field]));
    const aspects = fields.get('aspects');
    expect(aspects?.type === 'repeater' && aspects.entryTypes?.map((entry) => entry.id)).toContain(
      'high_concept',
    );
    const skills = fields.get('skills');
    const rating =
      skills?.type === 'repeater' ? skills.of.find((f) => f.key === 'rating') : undefined;
    expect(rating?.type === 'number' && rating.ladder).toBe('adjectives');
    expect(system.mechanics.ladders[0]?.steps.find((step) => step.value === 4)?.label).toBe(
      'Great',
    );
  });
});

describe('Fate: Fate points', () => {
  const system = installed('fate-core');
  const run = (key: string, current: number) => {
    const base = state({ resources: { fate_points: { current } } });
    const prepared = prepareAction(system, key, base);
    if (!prepared.ok) throw new Error(prepared.error.code);
    const planned = planOutcome(prepared.value);
    if (!planned.ok) throw new Error(planned.error.code);
    return resolvePlan(prepared.value, planned.value);
  };

  test('spending is guarded, and the last point cannot be spent twice', () => {
    const spent = run('invoke_aspect', 1);
    expect(spent.ok && spent.value.operations[0]?.requires).toEqual({
      path: 'resources.fate_points.current',
      atLeast: 1,
    });
    expect(run('invoke_aspect', 0)).toEqual({
      ok: false,
      error: { code: 'item_refused', subject: '0' },
    });
  });

  test('gaining one adds one', () => {
    const gained = run('gain_fate_point', 2);
    expect(gained.ok && gained.value.changes).toEqual([
      { path: 'resources.fate_points.current', before: 2, after: 3 },
    ]);
  });

  test('a session refreshes up to refresh, and never takes points away', () => {
    const recover = (current: number) => {
      const base = state({
        fields: { refresh: 3 },
        resources: { fate_points: { current } },
      });
      const plan = planRecovery(system, base, 'session_start');
      if (!plan.ok) throw new Error(plan.error.code);
      return plan.value.items[0];
    };
    expect(recover(1)?.changes).toEqual([
      { path: 'resources.fate_points.current', before: 1, after: 3 },
    ]);
    expect(recover(5)?.status).toBe('no_effect');
  });

  test('stress clears after a conflict', () => {
    const base = state({
      tracks: { physical_stress: { one: true }, mental_stress: { two: true } },
    });
    const plan = planRecovery(system, base, 'conflict_end');
    if (!plan.ok) throw new Error(plan.error.code);
    const resolved = resolvePlan({ system, state: base }, plan.value);
    expect(resolved.ok && resolved.value.changes).toEqual([
      { path: 'tracks.physical_stress.one', before: true, after: false },
      { path: 'tracks.mental_stress.two', before: true, after: false },
    ]);
  });
});
