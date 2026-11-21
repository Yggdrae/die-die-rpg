import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  applyPlannedOperations,
  EffectLocalRepository,
  type EffectRecord,
  type TargetState,
} from '@rpg/actions';
import { InMemoryRepository } from '@rpg/contracts/testing';
import { FIXTURE_SYSTEM_PACKAGE } from '@rpg/fixtures';
import { INSTALLED_SYSTEM_PACKAGES } from '@rpg/installed-systems';
import type { SystemPackage } from '@rpg/systems';
import { CharacterLocalRepository } from './offline.ts';
import { type CharacterRecord, type CharacterSecretRecord, characterCodec } from './records.ts';
import {
  characterSummary,
  computedValues,
  displayName,
  editPlan,
  entriesOf,
  initialCharacterState,
  isDeclaredPath,
  isGmOnlyPath,
  itemsOf,
  mergeState,
  type SheetEdit,
  sheetLayout,
  splitState,
} from './sheet.ts';

const SYSTEMS: readonly SystemPackage[] = [
  FIXTURE_SYSTEM_PACKAGE,
  ...(INSTALLED_SYSTEM_PACKAGES as readonly SystemPackage[]),
];
// Installed packages are picked by what they declare, never by id (guard `no-system-identity`).
const declaring = (key: string) =>
  (INSTALLED_SYSTEM_PACKAGES as readonly SystemPackage[]).find((system) =>
    system.characterSchema.fields.some((field) => field.key === key),
  ) as SystemPackage;
const FIXTURE = FIXTURE_SYSTEM_PACKAGE;
const CAIRN = declaring('pack');
const FATE = declaring('physical_stress');

function edit(system: SystemPackage, state: TargetState, change: SheetEdit, gm = false) {
  const plan = editPlan(system, state, change, gm);
  if (!plan.ok) return { error: plan.error };
  const applied = applyPlannedOperations(state, plan.value.operations);
  if (!applied.ok) throw new Error(applied.error.code);
  return { plan: plan.value, state: applied.value.state };
}

describe.each(SYSTEMS.map((system) => [system.manifest.name, system] as const))(
  '%s sheet',
  (_name, system) => {
    test('every declared field appears once, in its group, with a component', () => {
      const layout = sheetLayout(system);
      const keys = layout.flatMap((group) => group.fields.map((item) => item.field.key));
      expect(keys.sort()).toEqual(system.characterSchema.fields.map((field) => field.key).sort());
      // P0 builds every component the installed packages declare (D-05).
      expect(
        layout.flatMap((group) => group.fields).filter((item) => item.component === 'unsupported'),
      ).toEqual([]);
    });

    test('a new character starts from defaults, named, and every default is a declared path', () => {
      const state = initialCharacterState(system, 'Ash');
      expect(displayName(system, state)).toBe('Ash');
      for (const key of Object.keys(state.fields))
        expect(isDeclaredPath(system, `fields.${key}`)).toBe(true);
      for (const key of Object.keys(state.resources)) {
        expect(isDeclaredPath(system, `resources.${key}.current`)).toBe(true);
      }
    });

    test('splitting and merging is lossless', () => {
      const state = initialCharacterState(system, 'Ash');
      const { visible, secret } = splitState(system, state);
      expect(mergeState(visible, secret)).toEqual(mergeState(state, undefined));
    });
  },
);

describe('GM-only values (D-06)', () => {
  test('the fixture GM note lives only in the secret half', () => {
    const state = initialCharacterState(FIXTURE, 'Ash');
    const { visible, secret } = splitState(FIXTURE, state);
    expect(isGmOnlyPath(FIXTURE, 'fields.gmNote')).toBe(true);
    expect(Object.keys(secret.fields)).toEqual(['gmNote']);
    expect(Object.hasOwn(visible.fields, 'gmNote')).toBe(false);
  });

  test('a player cannot edit it; a GM can', () => {
    const state = initialCharacterState(FIXTURE, 'Ash');
    const change: SheetEdit = { kind: 'set_field', field: 'gmNote', value: 'Owes the guild' };
    expect(edit(FIXTURE, state, change).error).toBe('gm_only');
    expect(edit(FIXTURE, state, change, true).state?.fields.gmNote).toBe('Owes the guild');
  });
});

describe('edits', () => {
  test('a resource tap is a merging delta, damage first from temporary points', () => {
    const state = initialCharacterState(CAIRN, 'Ash');
    const down = edit(CAIRN, state, { kind: 'adjust_resource', resource: 'hp', by: -1 });
    expect(down.plan?.operations.map(({ operation }) => operation.op)).toEqual(['delta', 'clamp']);
    expect(down.state?.resources.hp?.current).toBe(2);
    const up = edit(CAIRN, down.state as TargetState, {
      kind: 'adjust_resource',
      resource: 'hp',
      by: 9,
    });
    expect(up.state?.resources.hp?.current).toBe(3);
  });

  test('a text edit is a set guarded by what the device saw', () => {
    const state = initialCharacterState(CAIRN, 'Ash');
    const renamed = edit(CAIRN, state, { kind: 'set_field', field: 'name', value: 'Bram' });
    expect(renamed.plan?.operations[0]).toEqual({
      operation: { op: 'set', path: 'fields.name', value: 'Bram' },
      requires: { path: 'fields.name', equals: 'Ash' },
    });
    // A second device that also saw "Ash" refuses, instead of overwriting.
    const other = editPlan(
      CAIRN,
      state,
      { kind: 'set_field', field: 'name', value: 'Cole' },
      false,
    );
    if (!other.ok) throw new Error(other.error);
    const late = applyPlannedOperations(renamed.state as TargetState, other.value.operations);
    expect(late.ok ? undefined : late.error.code).toBe('target_changed');
  });

  test.each<[string, SystemPackage, SheetEdit, string]>([
    [
      'an undeclared field',
      CAIRN,
      { kind: 'set_field', field: 'nope', value: 'x' },
      'unknown_field',
    ],
    [
      'a value outside a select',
      FIXTURE,
      { kind: 'set_field', field: 'standing', value: 'hero' },
      'not_in_values',
    ],
    [
      'the wrong type',
      FIXTURE,
      { kind: 'set_field', field: 'exhausted', value: 'yes' },
      'invalid_value',
    ],
    [
      'text past the limit',
      CAIRN,
      { kind: 'set_field', field: 'name', value: 'x'.repeat(81) },
      'too_long',
    ],
    [
      'a computed field',
      FIXTURE,
      { kind: 'set_field', field: 'carried', value: 'x' },
      'unknown_field',
    ],
    ['a zero adjustment', CAIRN, { kind: 'adjust_field', field: 'STR', by: 0 }, 'invalid_value'],
    [
      'an unknown box',
      FATE,
      { kind: 'toggle_box', resource: 'physical_stress', box: 'nine' },
      'unknown_field',
    ],
  ])('%s is refused', (_name, system, change, failure) => {
    expect(edit(system, initialCharacterState(system, 'Ash'), change).error).toBe(failure as never);
  });

  test('a number stays inside its bounds', () => {
    const state = initialCharacterState(CAIRN, 'Ash');
    const lowered = edit(CAIRN, state, { kind: 'adjust_field', field: 'armor', by: 9 });
    expect(lowered.state?.fields.armor).toBe(3);
  });

  test('boxes toggle, slots fill with a guard, conditions count', () => {
    const state = initialCharacterState(FATE, 'Ash');
    const marked = edit(FATE, state, {
      kind: 'toggle_box',
      resource: 'physical_stress',
      box: 'two',
    });
    expect(marked.state?.tracks.physical_stress?.two).toBe(true);
    const cleared = edit(FATE, marked.state as TargetState, {
      kind: 'toggle_box',
      resource: 'physical_stress',
      box: 'two',
    });
    expect(cleared.state?.tracks.physical_stress?.two).toBe(false);
    const slot = edit(FATE, state, {
      kind: 'set_slot',
      field: 'consequences',
      slot: 'mild',
      text: 'Bruised',
    });
    expect(slot.state?.slots.consequences?.mild).toBe('Bruised');
    const tired = edit(CAIRN, initialCharacterState(CAIRN, 'Ash'), {
      kind: 'adjust_condition',
      condition: 'fatigue',
      by: 1,
    });
    expect(tired.state?.conditions.fatigue).toBe(1);
  });

  test('repeater entries: add with a type, edit, and remove; a number entry merges', () => {
    let state = initialCharacterState(FATE, 'Ash');
    const added = edit(FATE, state, { kind: 'add_entry', field: 'skills', id: 'fight' });
    state = added.state as TargetState;
    const rated = edit(FATE, state, {
      kind: 'set_entry',
      field: 'skills',
      id: 'fight',
      subfield: 'rating',
      value: 3,
    });
    expect(rated.plan?.operations.map(({ operation }) => operation.op)).toEqual(['delta', 'clamp']);
    state = rated.state as TargetState;
    state = edit(FATE, state, {
      kind: 'set_entry',
      field: 'skills',
      id: 'fight',
      subfield: 'skill',
      value: 'Fight',
    }).state as TargetState;
    expect(entriesOf(state, 'skills')).toEqual([
      { id: 'fight', values: { _order: 1, skill: 'Fight', rating: 3 } },
    ]);
    const aspect = edit(FATE, state, {
      kind: 'add_entry',
      field: 'aspects',
      id: 'concept',
      entryType: 'high_concept',
    });
    expect(entriesOf(aspect.state as TargetState, 'aspects')[0]?.values._type).toBe('high_concept');
    expect(
      edit(FATE, state, { kind: 'add_entry', field: 'aspects', id: 'x', entryType: 'nope' }).error,
    ).toBe('not_in_values');
    const removed = edit(FATE, state, { kind: 'remove_entry', field: 'skills', id: 'fight' });
    expect(entriesOf(removed.state as TargetState, 'skills')).toEqual([]);
  });

  test('a list is entries of text', () => {
    const state = initialCharacterState(CAIRN, 'Ash');
    const added = edit(CAIRN, state, { kind: 'add_entry', field: 'traits', id: 't1' })
      .state as TargetState;
    const named = edit(CAIRN, added, {
      kind: 'set_entry',
      field: 'traits',
      id: 't1',
      subfield: 'text',
      value: 'Wiry',
    });
    expect(entriesOf(named.state as TargetState, 'traits')[0]?.values.text).toBe('Wiry');
  });

  test('inventory: add, move with a capacity warning, remove', () => {
    let state = initialCharacterState(CAIRN, 'Ash');
    state = edit(CAIRN, state, { kind: 'add_item', id: 'rope', name: 'Rope', slot: 1 })
      .state as TargetState;
    const moved = edit(CAIRN, state, { kind: 'move_item', id: 'rope', slot: 4 });
    state = moved.state as TargetState;
    expect(itemsOf(state, 'pack')).toEqual([{ id: 'rope', name: 'Rope', slot: 4, size: 1 }]);
    state = edit(CAIRN, state, { kind: 'remove_item', id: 'rope' }).state as TargetState;
    expect(itemsOf(state, 'pack')).toEqual([]);
  });

  test('computed fields follow what they read', () => {
    const state = initialCharacterState(FIXTURE, 'Ash');
    const before = computedValues(FIXTURE, state).carried as number;
    const raised = edit(FIXTURE, state, { kind: 'adjust_field', field: 'VIGOR', by: 1 });
    expect(computedValues(FIXTURE, raised.state as TargetState).carried).toBe(before + 1);
  });
});

describe('CharacterLocalRepository', () => {
  const ACTOR = '00000000-0000-4000-8000-0000000015a1';
  const CAMPAIGN = '00000000-0000-4000-8000-0000000015c1';

  function setup(secrets: CharacterSecretRecord[] = []) {
    const effects = new EffectLocalRepository(new InMemoryRepository<EffectRecord>(), {
      userId: ACTOR,
      campaignId: CAMPAIGN,
    });
    const records = new InMemoryRepository<CharacterRecord>();
    const repository = new CharacterLocalRepository(
      records,
      { list: async () => secrets },
      effects,
      { userId: ACTOR, campaignId: CAMPAIGN },
    );
    return { repository, effects };
  }

  test('create, edit at once, and display through the overlay', async () => {
    const { repository, effects } = setup();
    const created = await repository.create(CAIRN, CAIRN.manifest.ref, '  Ash ');
    if (!created.ok) throw new Error(JSON.stringify(created.error));
    expect(created.value.state.fields.name).toBe('Ash');
    expect(created.value.visibility).toEqual({ mode: 'players', playerIds: [ACTOR] });
    const edited = await repository.edit(
      CAIRN,
      created.value,
      {
        kind: 'adjust_resource',
        resource: 'hp',
        by: -1,
      },
      false,
    );
    expect(edited.ok).toBe(true);
    const shown = await repository.displayed(created.value);
    expect(shown.resources.hp?.current).toBe(2);
    // The row itself is untouched: the authority writes it.
    expect(created.value.state.resources.hp?.current).toBe(3);
    expect((await effects.list()).length).toBe(1);
  });

  test('a GM device shows the secret half; a refused edit stops counting', async () => {
    const { repository } = setup();
    const created = await repository.create(FIXTURE, FIXTURE.manifest.ref, 'Ash');
    if (!created.ok) throw new Error('create');
    const withSecret = setup([
      {
        id: created.value.id,
        campaignId: CAMPAIGN,
        state: splitState(FIXTURE, initialCharacterState(FIXTURE, 'Ash')).secret,
        version: 1,
        updatedAt: created.value.updatedAt,
      },
    ]);
    const shown = await withSecret.repository.displayed(created.value);
    expect(shown.fields.gmNote).toBe('');
    const edited = await withSecret.repository.edit(
      FIXTURE,
      created.value,
      { kind: 'set_field', field: 'gmNote', value: 'Watch her' },
      true,
    );
    if (!edited.ok) throw new Error('edit');
    expect((await withSecret.repository.displayed(created.value)).fields.gmNote).toBe('Watch her');
    expect(
      (await withSecret.repository.displayed(created.value, new Set([edited.value]))).fields.gmNote,
    ).toBe('');
  });

  test('an empty name, and an invalid edit, queue nothing', async () => {
    const { repository, effects } = setup();
    expect(await repository.create(CAIRN, CAIRN.manifest.ref, '  ')).toEqual({
      ok: false,
      error: { code: 'invalid_name' },
    });
    const created = await repository.create(CAIRN, CAIRN.manifest.ref, 'Ash');
    if (!created.ok) throw new Error('create');
    expect(
      await repository.edit(
        CAIRN,
        created.value,
        { kind: 'set_field', field: 'nope', value: 'x' },
        false,
      ),
    ).toEqual({ ok: false, error: { code: 'edit', failure: 'unknown_field' } });
    expect(await effects.list()).toEqual([]);
  });

  test('the replica row round-trips, with the name derived from the state', async () => {
    const { repository } = setup();
    const created = await repository.create(CAIRN, CAIRN.manifest.ref, 'Ash');
    if (!created.ok) throw new Error('create');
    const codec = characterCodec((record) => displayName(CAIRN, record.state));
    expect(codec.fromRow({ ...codec.toRow(created.value), id: created.value.id })).toEqual(
      created.value,
    );
    expect(
      codec.fromRow({ ...codec.toRow(created.value), id: created.value.id, state: '{bad' }),
    ).toBeUndefined();
  });
});

describe('purity', () => {
  test('the package names no system', () => {
    const directory = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
    for (const name of readdirSync(directory)) {
      if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue;
      const code = readFileSync(join(directory, name), 'utf8');
      expect({ name, match: /cairn|fate-core|fixture-system/i.exec(code)?.[0] }).toEqual({
        name,
        match: undefined,
      });
    }
  });
});

describe('characterSummary (feature 18 party panel)', () => {
  test('the fixture shows its pool with the maximum', () => {
    const state = initialCharacterState(FIXTURE, 'Mara');
    const summary = characterSummary(FIXTURE, state);
    expect(summary.map((value) => value.key)).toEqual(['focus']);
    expect(summary[0]?.text).toMatch(/^\d+\/\d+$/);
  });

  test('Cairn-like packages show a formula maximum and a number, never the name', () => {
    const state = initialCharacterState(CAIRN, 'Bryn');
    const summary = characterSummary(CAIRN, state);
    expect(summary.map((value) => value.key)).toEqual(
      CAIRN.characterSchema.summaryFields.filter((key) => key !== 'name'),
    );
    for (const value of summary) expect(value.text).not.toBe('');
  });

  test('tracks count their marked boxes', () => {
    const state = initialCharacterState(FATE, 'Ash');
    const track = FATE.resources.find((resource) => resource.shape === 'track');
    if (track === undefined || track.shape !== 'track') throw new Error('no track');
    const box = track.boxes[0]?.id ?? '';
    const marked = { ...state, tracks: { ...state.tracks, [track.key]: { [box]: true } } };
    const value = characterSummary(FATE, marked).find((item) => item.key === track.key);
    expect(value?.text).toBe(`1/${track.boxes.length} marked`);
  });
});
