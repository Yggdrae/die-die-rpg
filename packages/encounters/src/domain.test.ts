import { describe, expect, test } from 'bun:test';
import { applyPlannedOperations, EffectLocalRepository, type EffectRecord } from '@rpg/actions';
import { characterSummary, editPlan, initialCharacterState } from '@rpg/characters';
import { InMemoryRepository } from '@rpg/contracts/testing';
import { FIXTURE_SYSTEM_PACKAGE } from '@rpg/fixtures';
import { INSTALLED_SYSTEM_PACKAGES } from '@rpg/installed-systems';
import type { SystemPackage } from '@rpg/systems';
import {
  activeConditions,
  changeEncounter,
  classifyEncounterUpdate,
  conditionControls,
  initialInstance,
  instanceLabels,
  isPublicConditionPath,
  mergeInstanceState,
  orderEncounters,
  participantControls,
  splitInstanceState,
} from './domain.ts';
import {
  EncounterLocalRepository,
  EncounterNotesLocalRepository,
  ParticipantLocalRepository,
} from './offline.ts';
import { PARTICIPANT_CLASS } from './policies.ts';
import {
  ENCOUNTER_NOTE_ROW_CODEC,
  ENCOUNTER_ROW_CODEC,
  type EncounterNoteRecord,
  type EncounterRecord,
  isValidParticipant,
  PARTICIPANT_ROW_CODEC,
  type ParticipantRecord,
  participantStateFromRow,
} from './records.ts';

const SYSTEMS: readonly SystemPackage[] = [
  FIXTURE_SYSTEM_PACKAGE,
  ...(INSTALLED_SYSTEM_PACKAGES as readonly SystemPackage[]),
];
// Installed packages are picked by what they declare, never by id (guard `no-system-identity`).
const declaring = (key: string) =>
  (INSTALLED_SYSTEM_PACKAGES as readonly SystemPackage[]).find((system) =>
    system.characterSchema.fields.some((field) => field.key === key),
  ) as SystemPackage;
const CAIRN = declaring('pack');
const FATE = declaring('physical_stress');

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const CAMPAIGN = id(1);
const GM = id(2);
const T0 = '2026-11-05T18:00:00.000Z';

function encounter(overrides: Partial<EncounterRecord> = {}): EncounterRecord {
  return {
    id: id(10),
    campaignId: CAMPAIGN,
    type: 'encounter',
    name: 'Ambush',
    tags: [],
    metadata: {},
    visibility: { mode: 'everyone' },
    version: 1,
    createdAt: T0,
    createdBy: GM,
    updatedAt: T0,
    updatedBy: GM,
    status: 'active',
    startedAt: T0,
    environment: '',
    ...overrides,
  };
}

function local() {
  const actor = { userId: GM, campaignId: CAMPAIGN };
  let n = 100;
  const createId = () => id(n++);
  const effectRows = new InMemoryRepository<EffectRecord>();
  const effects = new EffectLocalRepository(effectRows, actor, { createId });
  const participantRows = new InMemoryRepository<ParticipantRecord>();
  return {
    effects,
    effectRows,
    participantRows,
    encounters: new EncounterLocalRepository(new InMemoryRepository<EncounterRecord>(), actor, {
      createId,
    }),
    notes: new EncounterNotesLocalRepository(new InMemoryRepository<EncounterNoteRecord>(), actor),
    participants: new ParticipantLocalRepository(
      participantRows,
      { list: async () => [] },
      effects,
      actor,
      { createId },
    ),
  };
}

describe('instance labels (D-04)', () => {
  test('a new label alone stays itself; a count numbers them', () => {
    expect(instanceLabels([], 'Ogre', 1)).toEqual({ ok: true, value: ['Ogre'] });
    expect(instanceLabels([], ' Bandit ', 3)).toEqual({
      ok: true,
      value: ['Bandit 1', 'Bandit 2', 'Bandit 3'],
    });
  });

  test('numbering continues after the highest present', () => {
    expect(instanceLabels(['Bandit 1', 'Bandit 3', 'Bandits 9'], 'Bandit', 1)).toEqual({
      ok: true,
      value: ['Bandit 4'],
    });
    // The unnumbered first one counts as 1.
    expect(instanceLabels(['Ogre'], 'Ogre', 1)).toEqual({ ok: true, value: ['Ogre 2'] });
  });

  test('bounds', () => {
    expect(instanceLabels([], '  ', 1)).toEqual({ ok: false, error: 'invalid_label' });
    expect(instanceLabels([], 'Rat', 0)).toEqual({ ok: false, error: 'invalid_count' });
    expect(instanceLabels([], 'Rat', 21)).toEqual({ ok: false, error: 'invalid_count' });
  });
});

describe('instance state split (D-05)', () => {
  test('only conditions declared everyone are public; split and merge round-trip', () => {
    for (const system of SYSTEMS) {
      const initial = initialCharacterState(system, 'Bandit');
      const withCondition = {
        ...initial,
        conditions: Object.fromEntries(system.mechanics.conditions.map((item) => [item.key, 1])),
      };
      const { conditions, secret } = splitInstanceState(system, withCondition);
      for (const key of Object.keys(conditions)) {
        expect(isPublicConditionPath(system, `conditions.${key}`)).toBe(true);
      }
      expect(Object.keys(secret.resources)).toEqual(Object.keys(initial.resources));
      expect(mergeInstanceState(conditions, secret)).toEqual(withCondition);
    }
    expect(isPublicConditionPath(CAIRN, 'resources.hp.current')).toBe(false);
    expect(isPublicConditionPath(CAIRN, 'conditions.fatigue')).toBe(true);
  });

  test('the initial instance is the package new character, named by its label', () => {
    const { secret } = initialInstance(FIXTURE_SYSTEM_PACKAGE, 'Bandit 2');
    expect(secret.fields.name).toBe('Bandit 2');
    expect(secret.resources.focus?.current).toBe(6);
  });
});

describe('controls from declarations (D-07, PRD s.47, s.89)', () => {
  test('each package gets controls for its own summary shapes and conditions', () => {
    const shapes = SYSTEMS.map((system) => {
      const state = initialCharacterState(system, 'X');
      return {
        controls: participantControls(system, state).map((control) => [
          control.key,
          control.buttons.map((button) => button.label),
        ]),
        conditions: conditionControls(system, state).length,
        summary: characterSummary(system, state).map((value) => value.key),
      };
    });
    expect(shapes[0]).toEqual({
      controls: [['focus', ['-1', '+1']]],
      conditions: 0,
      summary: ['focus'],
    });
    const cairn = SYSTEMS.indexOf(CAIRN);
    const fate = SYSTEMS.indexOf(FATE);
    expect(shapes[cairn]?.controls).toEqual([
      ['hp', ['-1', '+1']],
      ['STR', ['-1', '+1']],
    ]);
    expect(shapes[cairn]?.conditions).toBe(CAIRN.mechanics.conditions.length);
    expect(shapes[fate]?.controls.map(([key]) => key)).toEqual([
      'fate_points',
      'physical_stress',
      'mental_stress',
    ]);
    // A track is a toggle per box; no turn order control exists anywhere (D-09).
    expect(shapes[fate]?.controls[1]?.[1]).toHaveLength(4);
  });

  test('every control is a valid feature 11 plan of delta, clamp, or a box toggle', () => {
    for (const system of SYSTEMS) {
      const state = initialCharacterState(system, 'X');
      const edits = [
        ...participantControls(system, state).flatMap((control) =>
          control.buttons.map((button) => button.edit),
        ),
        ...conditionControls(system, state).map((control) => control.add),
      ];
      for (const edit of edits) {
        const plan = editPlan(system, state, edit, true);
        if (!plan.ok) {
          // A pool at its maximum has nothing to heal; everything else plans.
          expect(plan.error).toBe('nothing_to_change');
          continue;
        }
        expect(plan.value.operations.length).toBeGreaterThan(0);
        expect(applyPlannedOperations(state, plan.value.operations).ok).toBe(true);
        for (const { operation } of plan.value.operations) {
          if (operation.path.startsWith('resources.') || operation.path.startsWith('conditions.')) {
            expect(['delta', 'clamp']).toContain(operation.op);
          }
        }
      }
    }
  });

  test('active conditions by label, with counts', () => {
    expect(activeConditions(CAIRN, { fatigue: 2, deprived: 1, scar: 0 })).toEqual([
      'Fatigue ×2',
      'Deprived',
    ]);
  });
});

describe('encounter changes (D-10)', () => {
  test('environment, then the end, which is final', () => {
    const changed = changeEncounter(encounter(), { kind: 'environment', environment: 'Fog' }, T0);
    expect(changed).toMatchObject({ ok: true, value: { environment: 'Fog' } });
    const ended = changeEncounter(encounter(), { kind: 'end' }, '2026-11-05T19:00:00.000Z');
    expect(ended).toMatchObject({ ok: true, value: { status: 'ended' } });
    if (!ended.ok) return;
    expect(changeEncounter(ended.value, { kind: 'end' }, T0)).toEqual({
      ok: false,
      error: 'ended',
    });
    expect(classifyEncounterUpdate(encounter(), ended.value)).toEqual({ ok: true, value: 'ended' });
    expect(classifyEncounterUpdate(ended.value, encounter())).toEqual({
      ok: false,
      error: 'invalid',
    });
    expect(classifyEncounterUpdate(encounter(), encounter({ name: 'Other' }))).toEqual({
      ok: false,
      error: 'invalid',
    });
    expect(
      changeEncounter(encounter(), { kind: 'environment', environment: 'x'.repeat(2001) }, T0),
    ).toEqual({ ok: false, error: 'too_long' });
  });

  test('open encounters first, newest first', () => {
    const old = encounter({ id: id(11), startedAt: '2026-11-01T18:00:00.000Z' });
    const ended = encounter({ id: id(12), status: 'ended', endedAt: T0 });
    expect(orderEncounters([ended, old, encounter()]).map((row) => row.id)).toEqual([
      id(10),
      id(11),
      id(12),
    ]);
  });
});

describe('codecs', () => {
  test('rows round-trip and invalid rows are dropped', () => {
    const record = encounter({ sessionId: id(20), locationId: id(21), environment: 'Fog' });
    expect(
      ENCOUNTER_ROW_CODEC.fromRow({ id: record.id, ...ENCOUNTER_ROW_CODEC.toRow(record) }),
    ).toEqual(record);
    expect(
      ENCOUNTER_ROW_CODEC.fromRow({
        id: record.id,
        ...ENCOUNTER_ROW_CODEC.toRow(record),
        status: 'ended',
      }),
    ).toBeUndefined();
    const note: EncounterNoteRecord = {
      ...encounter(),
      type: 'encounter_gm_note',
      name: 'GM notes',
      visibility: { mode: 'gm_only' },
      body: 'Ambushers flee',
    } as unknown as EncounterNoteRecord;
    const {
      status: _s,
      startedAt: _t,
      environment: _e,
      ...noteRecord
    } = note as unknown as Record<string, unknown>;
    expect(
      ENCOUNTER_NOTE_ROW_CODEC.fromRow({
        id: note.id,
        ...ENCOUNTER_NOTE_ROW_CODEC.toRow(noteRecord as unknown as EncounterNoteRecord),
      }),
    ).toEqual(noteRecord as unknown as EncounterNoteRecord);
    expect(participantStateFromRow({ id: id(3), campaign_id: CAMPAIGN, state: '{}' })).toBe(
      undefined,
    );
  });

  test('a character participant carries no conditions; Visibility is everyone or gm_only', () => {
    const participant: ParticipantRecord = {
      ...encounter(),
      type: 'encounter_participant',
      name: 'Ash',
      encounterId: id(10),
      sourceKind: 'character',
      sourceId: id(30),
      position: 0,
      conditions: {},
    } as unknown as ParticipantRecord;
    const {
      status: _s,
      startedAt: _t,
      environment: _e,
      ...row
    } = participant as unknown as Record<string, unknown>;
    expect(isValidParticipant(row)).toBe(true);
    expect(isValidParticipant({ ...row, conditions: { fatigue: 1 } })).toBe(false);
    expect(isValidParticipant({ ...row, visibility: { mode: 'players', playerIds: [GM] } })).toBe(
      false,
    );
    expect(
      PARTICIPANT_ROW_CODEC.fromRow({
        id: participant.id,
        ...PARTICIPANT_ROW_CODEC.toRow(row as unknown as ParticipantRecord),
      }),
    ).toEqual(row as unknown as ParticipantRecord);
  });
});

describe('device repositories (FR-002, FR-003, FR-006, FR-010, FR-012)', () => {
  test('start, three distinct instances, one-interaction damage, conditions, end', async () => {
    const device = local();
    const started = await device.encounters.start({ name: 'Ambush', sessionId: id(50) });
    if (!started.ok) throw new Error('start');
    const added = await device.participants.add(CAIRN, started.value, [
      { sourceKind: 'character', sourceId: id(60), label: 'Ash' },
      { sourceKind: 'entity', sourceId: id(61), label: 'Bandit', count: 3 },
    ]);
    if (!added.ok) throw new Error('add');
    expect(added.value.map((row) => [row.name, row.position])).toEqual([
      ['Ash', 0],
      ['Bandit 1', 1],
      ['Bandit 2', 2],
      ['Bandit 3', 3],
    ]);
    const [, first, second] = added.value as [
      ParticipantRecord,
      ParticipantRecord,
      ParticipantRecord,
    ];
    const before = await device.participants.displayed(CAIRN, first);
    const hp = before.resources.hp?.current ?? 0;
    const hit = await device.participants.edit(CAIRN, started.value, first, {
      kind: 'adjust_resource',
      resource: 'hp',
      by: -1,
    });
    expect(hit.ok).toBe(true);
    // Exactly one application, a delta, on this instance only, with the session ID (D-08).
    const records = await device.effects.list();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      targetClass: PARTICIPANT_CLASS,
      targetId: first.id,
      sessionId: id(50),
      visibility: { mode: 'gm_only' },
    });
    expect(records[0]?.operations[0]?.operation.op).toBe('delta');
    expect((await device.participants.displayed(CAIRN, first)).resources.hp?.current).toBe(hp - 1);
    expect((await device.participants.displayed(CAIRN, second)).resources.hp?.current).toBe(hp);
    // A public condition on a visible participant is a visible record.
    await device.participants.edit(CAIRN, started.value, first, {
      kind: 'adjust_condition',
      condition: 'fatigue',
      by: 1,
    });
    expect((await device.effects.list())[1]?.visibility).toEqual({ mode: 'everyone' });
    expect((await device.participants.displayed(CAIRN, first)).conditions.fatigue).toBe(1);

    const more = await device.participants.add(CAIRN, started.value, [
      { sourceKind: 'entity', sourceId: id(61), label: 'Bandit' },
    ]);
    expect(more.ok && more.value[0]?.name).toBe('Bandit 4');
    expect((await device.participants.remove(second)).ok).toBe(true);
    expect((await device.participants.list(started.value.id)).map((row) => row.name)).toEqual([
      'Ash',
      'Bandit 1',
      'Bandit 3',
      'Bandit 4',
    ]);

    const ended = await device.encounters.end(started.value.id);
    if (!ended.ok) throw new Error('end');
    expect(
      await device.participants.edit(CAIRN, ended.value, first, {
        kind: 'adjust_resource',
        resource: 'hp',
        by: -1,
      }),
    ).toEqual({ ok: false, error: { code: 'ended' } });
    expect(
      await device.participants.add(CAIRN, ended.value, [
        { sourceKind: 'entity', sourceId: id(61), label: 'Late' },
      ]),
    ).toEqual({ ok: false, error: { code: 'ended' } });
    expect(await device.encounters.end(started.value.id)).toEqual({
      ok: false,
      error: { code: 'change', failure: 'ended' },
    });
  });

  test('reveal is one way; notes are versioned', async () => {
    const device = local();
    const started = await device.encounters.start({ name: 'Ambush' });
    if (!started.ok) throw new Error('start');
    const added = await device.participants.add(FIXTURE_SYSTEM_PACKAGE, started.value, [
      { sourceKind: 'entity', sourceId: id(61), label: 'Lurker', hidden: true },
    ]);
    if (!added.ok) throw new Error('add');
    const lurker = added.value[0] as ParticipantRecord;
    expect(lurker.visibility).toEqual({ mode: 'gm_only' });
    const revealed = await device.participants.reveal(lurker);
    expect(revealed.ok && revealed.value.visibility).toEqual({ mode: 'everyone' });
    expect((await device.notes.save(started.value.id, 'Flee at half', null)).ok).toBe(true);
    expect((await device.notes.save(started.value.id, 'x'.repeat(5001), 1)).ok).toBe(false);
    expect(await device.encounters.start({ name: '   ' })).toEqual({
      ok: false,
      error: { code: 'invalid_text' },
    });
  });
});
