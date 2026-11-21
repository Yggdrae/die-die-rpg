import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionQuickAction } from '@rpg/contracts';
import { InMemoryRepository } from '@rpg/contracts/testing';
import {
  type ContextEntity,
  SessionLocalRepository,
  type SessionLogEntryRecord,
  SessionLogLocalRepository,
  type SessionNoteRecord,
  SessionNotesLocalRepository,
  type SessionRecord,
  sessionLog,
} from '@rpg/sessions';
import { renderToStaticMarkup } from 'react-dom/server';
import { GmSessionView, NoSessionView, PlayerSessionView } from './SessionWorkspace.tsx';
import {
  availableActions,
  logLineText,
  paletteEntries,
  paletteResults,
  statusLabel,
} from './session-model.ts';
import type { SessionSource } from './session-source.ts';
import { readSessionData, type SessionData } from './useSessionData.ts';

/** Feature 18 view model and static markup (react-dom/server; no DOM library in this repo). */

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const CAMPAIGN = id(1);
const GM = id(2);
const ANA = id(3);
const T0 = '2026-11-03T18:00:00.000Z';

const SCENE: ContextEntity = {
  id: id(30),
  type: 'scene',
  name: 'Old Warehouse',
  summary: 'Dusty',
};
const DISTRICT: ContextEntity = {
  id: id(31),
  type: 'location',
  name: 'Lower District',
  summary: '',
};
const MERCHANT: ContextEntity = { id: id(32), type: 'npc', name: 'Merchant', summary: 'Nervous' };
const LETTER: ContextEntity = {
  id: id(33),
  type: 'handout',
  name: 'Weathered letter',
  summary: '',
};

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: id(10),
    campaignId: CAMPAIGN,
    type: 'session',
    name: 'Session 3',
    tags: [],
    metadata: {},
    visibility: { mode: 'everyone' },
    version: 2,
    createdAt: T0,
    createdBy: GM,
    updatedAt: T0,
    updatedBy: GM,
    number: 3,
    status: 'active',
    startedAt: T0,
    currentSceneId: SCENE.id,
    participantUserIds: [GM, ANA],
    ...overrides,
  };
}

function entry(overrides: Partial<SessionLogEntryRecord>): SessionLogEntryRecord {
  return {
    id: id(40),
    campaignId: CAMPAIGN,
    type: 'session_log_entry',
    name: 'note',
    tags: [],
    metadata: {},
    visibility: { mode: 'gm_only' },
    version: 1,
    createdAt: '2026-11-03T18:05:00.000Z',
    createdBy: GM,
    updatedAt: '2026-11-03T18:05:00.000Z',
    updatedBy: GM,
    sessionId: id(10),
    kind: 'note',
    text: 'Crates hide a second entrance.',
    ...overrides,
  };
}

const ACTIONS: readonly SessionQuickAction[] = [
  { id: 'content.add_npc', label: 'Add NPC', invoke: async () => undefined },
  { id: 'handouts.reveal', label: 'Reveal handout', invoke: async () => undefined },
  {
    id: 'inventory.check',
    label: 'Check inventory',
    capability: 'inventory_slots',
    invoke: async () => undefined,
  },
];

function data(overrides: Partial<SessionData> = {}): SessionData {
  const open = session();
  return {
    loaded: true,
    role: 'gm',
    mayRun: true,
    sessions: [open],
    open,
    notes: {
      ...session(),
      type: 'session_gm_note',
      name: 'GM notes',
      visibility: { mode: 'gm_only' },
      body: 'The ferryman lies.',
    } as unknown as SessionNoteRecord,
    entries: [
      entry({
        id: id(41),
        kind: 'status',
        text: 'started',
        visibility: { mode: 'everyone' },
        createdAt: T0,
      }),
      entry({}),
      entry({
        id: id(42),
        kind: 'reveal',
        text: '',
        subjectId: LETTER.id,
        createdAt: '2026-11-03T18:06:00.000Z',
      }),
    ],
    entities: [SCENE, DISTRICT, MERCHANT, LETTER],
    relationships: [
      { sourceEntityId: SCENE.id, targetEntityId: DISTRICT.id, kind: 'located_at' },
      { sourceEntityId: MERCHANT.id, targetEntityId: SCENE.id, kind: 'appears_in' },
    ],
    party: [
      {
        id: id(50),
        ownerUserId: ANA,
        name: 'Bryn',
        summary: [{ key: 'hp', label: 'HP', text: '4/6' }],
      },
    ],
    rolls: [
      {
        id: id(60),
        name: '1d20',
        result: { modified: 17 },
        rolledAt: '2026-11-03T18:03:00.000Z',
        visibility: { mode: 'gm_only' },
      },
    ],
    effects: [],
    capabilities: [],
    conflicts: [],
    ...overrides,
  };
}

const noop = () => undefined;
const yes = async () => true;

describe('session view model', () => {
  test('labels, log text, and capability-gated actions (D-11)', () => {
    expect(statusLabel('paused')).toBe('Paused');
    const lines = sessionLog({ session: session(), ...data() });
    const names = new Map([[LETTER.id, LETTER.name]]);
    expect(lines.map((line) => logLineText(line, names))).toEqual([
      'Session started',
      '1d20: 17',
      'Crates hide a second entrance.',
      'Revealed Weathered letter',
    ]);
    // A subject this device does not hold is never named.
    expect(logLineText(lines[3] as (typeof lines)[number], new Map())).toBe('Revealed content');
    expect(availableActions(ACTIONS, []).map((action) => action.id)).toEqual([
      'content.add_npc',
      'handouts.reveal',
    ]);
    expect(availableActions(ACTIONS, ['inventory_slots']).length).toBe(3);
  });

  test('the palette runs operations, sets scenes, looks up entities, and logs what was typed (D-12)', () => {
    const entries = paletteEntries({
      session: session({ currentSceneId: undefined }),
      actions: ACTIONS.slice(0, 2),
      entities: [SCENE, MERCHANT],
    });
    expect(paletteResults(entries, 'reveal').map((item) => item.label)).toEqual([
      'Reveal handout',
      'Add to log: reveal',
    ]);
    expect(paletteResults(entries, 'ware').map((item) => item.run)).toEqual([
      { kind: 'scene', sceneId: SCENE.id },
      { kind: 'lookup', entityId: SCENE.id },
      { kind: 'note', text: 'ware' },
    ]);
    expect(paletteResults(entries, 'pause')[0]?.run).toEqual({ kind: 'pause' });
    expect(
      paletteEntries({ session: session({ status: 'paused' }), actions: [], entities: [] }).map(
        (item) => item.label,
      ),
    ).toEqual(['Resume session', 'End session']);
  });

  test('a shell provider replaces the direct lookup; scenes stay the session own (D-12, feature 20 FR-008)', () => {
    const opened: string[] = [];
    const provider = {
      id: 'search',
      entries: (query: string) =>
        query === 'ware'
          ? [
              { id: 'p1', label: SCENE.name, group: 'Scene', subjectId: SCENE.id },
              { id: 'p2', label: 'Ware Road', group: 'Other', open: () => opened.push('p2') },
            ]
          : [],
    };
    const entries = paletteEntries({
      session: session({ currentSceneId: undefined }),
      actions: [],
      entities: [SCENE, MERCHANT],
      lookups: false,
    });
    const results = paletteResults(entries, 'ware', [provider]);
    expect(results.map((item) => [item.label, item.run.kind])).toEqual([
      [`Set scene: ${SCENE.name}`, 'scene'],
      [SCENE.name, 'provided'],
      ['Ware Road', 'provided'],
      ['Add to log: ware', 'note'],
    ]);
    expect(results[1]?.run).toEqual({ kind: 'provided', subjectId: SCENE.id });
    const road = results[2]?.run;
    if (road?.kind === 'provided') road.open?.();
    expect(opened).toEqual(['p2']);
    // Without a query, providers are not asked.
    expect(
      paletteResults(entries, '', [provider]).some((item) => item.run.kind === 'provided'),
    ).toBe(false);
  });
});

describe('session screens (static markup)', () => {
  test('the GM screen has every region of PRD s.44 on one screen', () => {
    const html = renderToStaticMarkup(
      <GmSessionView
        data={data()}
        session={session()}
        actions={ACTIONS.slice(0, 2)}
        onChange={noop}
        onInvoke={noop}
        onPalette={noop}
        onCloseLookup={noop}
        onSaveNotes={yes}
        onAddNote={yes}
      />,
    );
    for (const region of ['Party', 'Current scene', 'Quick actions', 'GM notes', 'Session log']) {
      expect(html).toContain(`aria-label="${region}"`);
    }
    expect(html).toContain('Session 3');
    expect(html).toContain('HP 4/6');
    expect(html).toContain('Lower District');
    expect(html).toContain('Merchant');
    expect(html).toContain('The ferryman lies.');
    expect(html).toContain('>Add NPC<');
    expect(html).toContain('>Reveal handout<');
    expect(html).toContain('Command palette (Ctrl+K)');
    expect(html).toContain('(GM only)');
  });

  test('the player view is different data: no GM control, no notes, no hidden scene', () => {
    const player = data({
      role: 'player',
      mayRun: false,
      notes: undefined,
      entities: [LETTER],
      relationships: [],
      rolls: [],
      entries: [
        entry({ id: id(41), kind: 'status', text: 'started', visibility: { mode: 'everyone' } }),
      ],
    });
    const html = renderToStaticMarkup(<PlayerSessionView data={player} userId={ANA} />);
    expect(html).toContain('Session 3');
    expect(html).toContain('Bryn');
    expect(html).toContain('Weathered letter');
    expect(html).toContain('Session started');
    for (const absent of ['GM notes', 'Pause', 'End session', 'Old Warehouse', 'Command palette']) {
      expect(html).not.toContain(absent);
    }
  });

  test('without an open session the GM can start the next one', () => {
    const ended = session({ status: 'ended', endedAt: '2026-11-03T21:00:00.000Z' });
    const html = renderToStaticMarkup(
      <NoSessionView data={{ sessions: [ended] }} onStart={noop} />,
    );
    expect(html).toContain('Start session 4');
    expect(html).toContain('Session 3, ended');
  });
});

describe('device data (offline)', () => {
  test('reads what the device holds; notes only for a GM device', async () => {
    const actor = { userId: GM, campaignId: CAMPAIGN };
    const log = new SessionLogLocalRepository(
      new InMemoryRepository<SessionLogEntryRecord>(),
      actor,
    );
    const sessions = new SessionLocalRepository(
      new InMemoryRepository<SessionRecord>(),
      log,
      actor,
    );
    const notes = new SessionNotesLocalRepository(
      new InMemoryRepository<SessionNoteRecord>(),
      actor,
    );
    const started = await sessions.start([GM]);
    if (!started.ok) throw new Error(started.error.code);
    await notes.save(started.value.id, 'Secret door', null);
    const source = (mayRun: boolean): SessionSource => ({
      userId: GM,
      campaignId: CAMPAIGN,
      sessions,
      notes,
      log,
      role: async () => (mayRun ? 'gm' : 'player'),
      mayRun: async () => mayRun,
      content: async () => ({ entities: [], relationships: [] }),
      party: async () => [],
      capabilities: async () => [],
      rolls: async () => [],
      effects: async () => [],
      conflicts: async () => [],
      resolveConflict: async () => undefined,
      subscribe: () => noop,
    });
    const gm = await readSessionData(source(true));
    expect(gm.open?.id).toBe(started.value.id);
    expect(gm.notes?.body).toBe('Secret door');
    expect(gm.entries.map((item) => item.text)).toEqual(['started']);
    expect((await readSessionData(source(false))).notes).toBeUndefined();
  });
});

describe('architecture (PRD constraint: no feature 16, 17, 19, or 20 internals)', () => {
  test('Session Mode imports none of the contributing web features', () => {
    const dir = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
    for (const file of readdirSync(dir)) {
      // The Playwright harness is test-only and composes like the app shell does.
      if (!/\.tsx?$/.test(file) || file.endsWith('.test.tsx') || file.startsWith('e2e-harness')) {
        continue;
      }
      const text = readFileSync(join(dir, file), 'utf8');
      expect({
        file,
        imports: /from '\.\.\/(content|handouts|encounters|search)\//.test(text),
      }).toEqual({
        file,
        imports: false,
      });
    }
  });
});
