import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EffectLocalRepository, type EffectRecord } from '@rpg/actions';
import {
  CharacterLocalRepository,
  type CharacterRecord,
  characterSummary,
  initialCharacterState,
} from '@rpg/characters';
import { EntityLocalRepository, type EntityRecord } from '@rpg/content';
import { InMemoryRepository } from '@rpg/contracts/testing';
import {
  EncounterLocalRepository,
  type EncounterNoteRecord,
  EncounterNotesLocalRepository,
  type EncounterRecord,
  ParticipantLocalRepository,
  type ParticipantRecord,
} from '@rpg/encounters';
import { FIXTURE_SYSTEM_PACKAGE } from '@rpg/fixtures';
import { INSTALLED_SYSTEM_PACKAGES } from '@rpg/installed-systems';
import type { SystemPackage } from '@rpg/systems';
import { renderToStaticMarkup } from 'react-dom/server';
import { GmEncounterView, ParticipantPicker, PlayerEncounterView } from './EncounterWorkspace.tsx';
import type { EncounterSource } from './encounter-source.ts';
import { ENCOUNTER_SESSION_QUICK_ACTIONS } from './session-quick-actions.ts';
import { readEncounterData } from './useEncounterData.ts';

/** Feature 19 view data and static markup (react-dom/server; no DOM library in this repo). */

const SYSTEMS: readonly SystemPackage[] = [
  FIXTURE_SYSTEM_PACKAGE,
  ...(INSTALLED_SYSTEM_PACKAGES as readonly SystemPackage[]),
];
// Installed packages are picked by what they declare, never by id (guard `no-system-identity`).
const CAIRN = (INSTALLED_SYSTEM_PACKAGES as readonly SystemPackage[]).find((system) =>
  system.mechanics.conditions.some((item) => item.visibility === 'everyone'),
) as SystemPackage;

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const CAMPAIGN = id(1);
const GM = id(2);
const ANA = id(3);
const T0 = '2026-11-05T18:00:00.000Z';

function character(system: SystemPackage, owner = ANA): CharacterRecord {
  return {
    id: id(40),
    campaignId: CAMPAIGN,
    type: 'character',
    name: 'Bryn',
    tags: [],
    metadata: {},
    visibility: { mode: 'players', playerIds: [owner] },
    version: 1,
    createdAt: T0,
    createdBy: owner,
    updatedAt: T0,
    updatedBy: owner,
    ownerUserId: owner,
    system: system.manifest.ref,
    state: initialCharacterState(system, 'Bryn'),
  };
}

/** A device over in-memory replicas: the production repositories, seeded through their own API. */
async function device(system: SystemPackage, input: { gm: boolean; userId?: string }) {
  const actor = { userId: input.userId ?? GM, campaignId: CAMPAIGN };
  const effects = new EffectLocalRepository(new InMemoryRepository<EffectRecord>(), actor);
  const characterRows = new InMemoryRepository<CharacterRecord>();
  await characterRows.upsert(character(system), null);
  const entityRows = new InMemoryRepository<EntityRecord>();
  const source: EncounterSource = {
    userId: actor.userId,
    campaignId: CAMPAIGN,
    encounters: new EncounterLocalRepository(new InMemoryRepository<EncounterRecord>(), actor),
    notes: new EncounterNotesLocalRepository(new InMemoryRepository<EncounterNoteRecord>(), actor),
    participants: new ParticipantLocalRepository(
      new InMemoryRepository<ParticipantRecord>(),
      { list: async () => [] },
      effects,
      actor,
    ),
    entities: new EntityLocalRepository(entityRows, actor),
    characters: new CharacterLocalRepository(
      characterRows,
      { list: async () => [] },
      effects,
      actor,
    ),
    system: async () => system,
    mayRun: async () => input.gm,
    mayEditGmOnly: async () => input.gm,
    refused: async () => new Set(),
    subscribe: () => () => undefined,
  };
  return source;
}

async function running(system: SystemPackage, gm = true) {
  const source = await device(system, { gm });
  const started = await source.encounters.start({ name: 'Ambush at the ford' });
  if (!started.ok) throw new Error('start');
  const bandit = await source.entities.create({ type: 'creature', name: 'Bandit' });
  if (!bandit.ok) throw new Error('entity');
  const added = await source.participants.add(system, started.value, [
    { sourceKind: 'character', sourceId: id(40), label: 'Bryn' },
    { sourceKind: 'entity', sourceId: bandit.value.id, label: 'Bandit', count: 3 },
    { sourceKind: 'entity', sourceId: bandit.value.id, label: 'Lurker', hidden: true },
  ]);
  if (!added.ok) throw new Error('add');
  return { source, encounter: started.value, participants: added.value };
}

const noop = () => undefined;

describe('tracker data (D-02, D-12)', () => {
  test('the GM holds each instance and the character; three bandits, three states', async () => {
    const { source, encounter } = await running(CAIRN);
    const data = await readEncounterData(source);
    const views = data.participants.get(encounter.id) ?? [];
    expect(views.map((view) => view.record.name)).toEqual([
      'Bryn',
      'Bandit 1',
      'Bandit 2',
      'Bandit 3',
      'Lurker',
    ]);
    expect(views.every((view) => view.state !== undefined)).toBe(true);
    expect(views[0]?.character?.id).toBe(id(40));
    expect(data.sources.map((item) => item.name)).toEqual(['Bandit']);
    expect(data.sources[0]?.hidden).toBe(true);
  });

  test('a player holds no instance state: labels and public conditions only', async () => {
    const { source, encounter, participants } = await running(CAIRN);
    const bandit = participants[1] as ParticipantRecord;
    // What a player replica holds: the participant row, with its public conditions.
    const player = await device(CAIRN, { gm: false, userId: ANA });
    await (
      player.participants as unknown as { records: InMemoryRepository<ParticipantRecord> }
    ).records.upsert({ ...bandit, conditions: { fatigue: 1 } }, null);
    await (
      player.encounters as unknown as { records: InMemoryRepository<EncounterRecord> }
    ).records.upsert(encounter, null);
    const data = await readEncounterData(player);
    const [view] = data.participants.get(encounter.id) ?? [];
    expect(view?.state).toBeUndefined();
    expect(view?.summary).toEqual([]);
    expect(view?.conditions).toEqual(['Fatigue']);
    const html = renderToStaticMarkup(<PlayerEncounterView encounter={encounter} data={data} />);
    expect(html).toContain('Bandit 1');
    expect(html).toContain('Fatigue');
    expect(html).not.toContain('HP');
    expect(html).not.toContain('<button');
    void source;
  });
});

describe('tracker screens (static markup, PRD s.47, s.89)', () => {
  test('every package renders its own declared values and controls, with no turn order', async () => {
    for (const system of SYSTEMS) {
      const { source, encounter } = await running(system);
      const data = await readEncounterData(source);
      const html = renderToStaticMarkup(
        <GmEncounterView
          encounter={encounter}
          data={data}
          onEdit={noop}
          onAdd={noop}
          onReveal={noop}
          onRemove={noop}
          onEnvironment={noop}
          onSaveNote={noop}
          onEnd={noop}
        />,
      );
      const state = initialCharacterState(system, 'Bandit 1');
      for (const value of characterSummary(system, state)) {
        expect(html).toContain(value.label);
      }
      for (const condition of system.mechanics.conditions) {
        expect(html).toContain(`aria-label="Add ${condition.label}"`);
      }
      expect(html).toContain('Reveal Lurker');
      expect(html).toContain('(hidden from players)');
      expect(html).toContain('End encounter');
      expect(html).not.toMatch(/initiative|round|turn order/i);
    }
  });

  test('the start form preselects the party and offers creatures and improvised enemies', async () => {
    const source = await device(CAIRN, { gm: true });
    const data = await readEncounterData(source);
    const html = renderToStaticMarkup(
      <ParticipantPicker
        label="Start encounter"
        submit="Start encounter"
        party={data.party}
        sources={[{ id: id(70), name: 'Wolf', hidden: false }]}
        preselectParty
        withName="Encounter 1"
        onSubmit={noop}
      />,
    );
    expect(html).toContain('aria-label="Start encounter"');
    expect(html).toMatch(/<input type="checkbox" checked=""\/>Bryn/);
    expect(html).toContain('Wolf');
    expect(html).toContain('Improvised enemy');
  });

  test('an ended encounter offers no controls', async () => {
    const { source, encounter } = await running(CAIRN);
    const ended = await source.encounters.end(encounter.id);
    if (!ended.ok) throw new Error('end');
    const html = renderToStaticMarkup(
      <GmEncounterView
        encounter={ended.value}
        data={await readEncounterData(source)}
        onEdit={noop}
        onAdd={noop}
        onReveal={noop}
        onRemove={noop}
        onEnvironment={noop}
        onSaveNote={noop}
        onEnd={noop}
      />,
    );
    expect(html).toContain('Ended');
    expect(html).not.toContain('Controls for');
    expect(html).not.toContain('End encounter');
  });
});

describe('Session Mode quick action (D-11)', () => {
  test('"Add encounter" implements the frozen contract and resolves without a host', async () => {
    expect(ENCOUNTER_SESSION_QUICK_ACTIONS.map((action) => [action.id, action.label])).toEqual([
      ['encounters.add', 'Add encounter'],
    ]);
    await ENCOUNTER_SESSION_QUICK_ACTIONS[0]?.invoke({
      actor: { userId: GM, campaignId: CAMPAIGN, role: 'gm' },
      sessionId: id(9),
    });
  });

  test('the tracker imports no other web feature', () => {
    const dir = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
    for (const file of readdirSync(dir)) {
      if (!/\.tsx?$/.test(file) || file.endsWith('.test.tsx') || file.startsWith('e2e-harness')) {
        continue;
      }
      const text = readFileSync(join(dir, file), 'utf8');
      expect({ file, imports: /from '\.\.\/[a-z-]+\//.test(text) }).toEqual({
        file,
        imports: false,
      });
    }
  });
});
