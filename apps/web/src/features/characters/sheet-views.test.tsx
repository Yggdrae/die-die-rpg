import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EMPTY_TARGET_STATE, planOutcome, prepareAction } from '@rpg/actions';
import { initialCharacterState } from '@rpg/characters';
import { FIXTURE_SYSTEM_PACKAGE } from '@rpg/fixtures';
import type { SystemPackage } from '@rpg/systems';
import { renderToStaticMarkup } from 'react-dom/server';
import { PlanView } from './ActionPanel.tsx';
import { installedRegistry } from './character-source.ts';
import { SheetView } from './SheetView.tsx';

/** Feature 15 static markup (react-dom/server; no DOM library in this repo). */

const systems = installedRegistry().list();
// Picked by what they declare, never by id (guard `no-system-identity`).
const declaring = (key: string) =>
  systems.find((system) =>
    system.characterSchema.fields.some((field) => field.key === key),
  ) as SystemPackage;

describe.each(systems.map((system) => [system.manifest.name, system] as const))(
  '%s',
  (_name, system) => {
    test('one sheet renders every declared field with its component, and nothing unsupported', () => {
      const html = renderToStaticMarkup(
        <SheetView
          system={system}
          state={initialCharacterState(system, 'Ash')}
          showGmOnly={true}
        />,
      );
      for (const field of system.characterSchema.fields) {
        expect(html).toContain(`data-field="${field.key}"`);
      }
      expect(html).not.toContain('data-unsupported-field');
      expect(html).toContain('value="Ash"');
    });
  },
);

describe('the sheet', () => {
  test('hides GM-only fields from a player, shows them to a GM', () => {
    const state = initialCharacterState(FIXTURE_SYSTEM_PACKAGE, 'Ash');
    const player = renderToStaticMarkup(
      <SheetView system={FIXTURE_SYSTEM_PACKAGE} state={state} showGmOnly={false} />,
    );
    const gm = renderToStaticMarkup(
      <SheetView system={FIXTURE_SYSTEM_PACKAGE} state={state} showGmOnly={true} />,
    );
    expect(player).not.toContain('data-field="gmNote"');
    expect(gm).toContain('data-field="gmNote"');
  });

  test('renders pools, tracks, slots, inventory, conditions, and computed values', () => {
    const fate = declaring('physical_stress');
    const cairn = declaring('pack');
    const fateHtml = renderToStaticMarkup(
      <SheetView
        system={fate}
        state={{
          ...initialCharacterState(fate, 'Ash'),
          tracks: { physical_stress: { two: true } },
        }}
        showGmOnly={false}
      />,
    );
    expect(fateHtml).toContain('data-track="physical_stress"');
    expect(fateHtml).toContain('data-slots="consequences"');
    expect(fateHtml).toContain('checked=""');
    const cairnHtml = renderToStaticMarkup(
      <SheetView
        system={cairn}
        state={{
          ...initialCharacterState(cairn, 'Ash'),
          inventory: { pack: { rope: { name: 'Rope', slot: 1, size: 1 } } },
          conditions: { fatigue: 2 },
        }}
        showGmOnly={false}
      />,
    );
    expect(cairnHtml).toContain('data-resource="hp"');
    expect(cairnHtml).toContain('Rope');
    // Two fatigue occupy slots beside the rope.
    expect(cairnHtml).toContain('Inventory: 3 / 10 slots');
    const fixture = renderToStaticMarkup(
      <SheetView
        system={FIXTURE_SYSTEM_PACKAGE}
        state={initialCharacterState(FIXTURE_SYSTEM_PACKAGE, 'Ash')}
        showGmOnly={false}
      />,
    );
    expect(fixture).toContain('data-component="computed"');
  });

  test('a component the sheet does not build degrades visibly', () => {
    const system = structuredClone(FIXTURE_SYSTEM_PACKAGE) as unknown as {
      characterSchema: { fields: Record<string, unknown>[] };
    };
    system.characterSchema.fields.push({
      key: 'friend',
      label: 'Friend',
      group: 'bonds',
      type: 'reference',
      targetType: 'npc',
    });
    const html = renderToStaticMarkup(
      <SheetView
        system={system as unknown as SystemPackage}
        state={EMPTY_TARGET_STATE}
        showGmOnly={false}
      />,
    );
    expect(html).toContain('data-unsupported-field="friend"');
    expect(html).toContain('Component unavailable: Friend');
  });

  test('a plan shows its outcome and each change before anything applies', () => {
    const cairn = declaring('pack');
    const state = { ...initialCharacterState(cairn, 'Ash'), resources: { hp: { current: 3 } } };
    const prepared = prepareAction(cairn, 'take_damage_d6', state);
    if (!prepared.ok) throw new Error(prepared.error.code);
    const planned = planOutcome(prepared.value, {
      terms: [{ kind: 'dice', sign: 1, die: 'd6', faces: [{ value: 2, kept: true }], subtotal: 2 }],
      natural: 2,
      modified: 2,
    });
    if (!planned.ok) throw new Error(planned.error.code);
    const html = renderToStaticMarkup(<PlanView plan={planned.value} />);
    expect(html).toContain('data-outcome="absorbed"');
    expect(html).toContain('resources.hp.current: 3 → 1');
  });
});

describe('purity', () => {
  test('no character screen names a system', () => {
    const directory = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
    for (const name of readdirSync(directory)) {
      if (!/\.tsx?$/.test(name) || name.includes('.test.')) continue;
      const code = readFileSync(join(directory, name), 'utf8');
      expect({ name, match: /cairn|fate-core|fate core/i.exec(code)?.[0] }).toEqual({
        name,
        match: undefined,
      });
    }
  });
});
