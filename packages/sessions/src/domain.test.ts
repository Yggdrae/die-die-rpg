import { describe, expect, test } from 'bun:test';
import {
  changeSession,
  classifyUpdate,
  initialParticipants,
  matchPalette,
  openSessionOf,
  provisionalNumber,
  sceneContext,
  sessionLog,
} from './domain.ts';
import {
  isValidLogEntry,
  SESSION_LOG_ROW_CODEC,
  SESSION_NOTE_ROW_CODEC,
  SESSION_ROW_CODEC,
  type SessionLogEntryRecord,
  type SessionRecord,
} from './records.ts';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const CAMPAIGN = id(1);
const GM = id(2);
const T0 = '2026-11-03T18:00:00.000Z';
const at = (minutes: number) => new Date(Date.parse(T0) + minutes * 60_000).toISOString();

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: id(10),
    campaignId: CAMPAIGN,
    type: 'session',
    name: 'Session 1',
    tags: [],
    metadata: {},
    visibility: { mode: 'everyone' },
    version: 1,
    createdAt: T0,
    createdBy: GM,
    updatedAt: T0,
    updatedBy: GM,
    number: 1,
    status: 'active',
    startedAt: T0,
    participantUserIds: [GM],
    ...overrides,
  };
}

function entry(overrides: Partial<SessionLogEntryRecord> = {}): SessionLogEntryRecord {
  return {
    id: id(20),
    campaignId: CAMPAIGN,
    type: 'session_log_entry',
    name: 'note',
    tags: [],
    metadata: {},
    visibility: { mode: 'gm_only' },
    version: 1,
    createdAt: at(5),
    createdBy: GM,
    updatedAt: at(5),
    updatedBy: GM,
    sessionId: id(10),
    kind: 'note',
    text: 'Crates hide a second entrance.',
    ...overrides,
  };
}

describe('lifecycle (D-05)', () => {
  test('active -> paused -> active -> ended, and ended is final', () => {
    const paused = changeSession(session(), { kind: 'pause' }, at(10));
    if (!paused.ok) throw new Error(paused.error);
    expect(paused.value).toMatchObject({ event: 'paused', record: { status: 'paused' } });
    const resumed = changeSession(paused.value.record, { kind: 'resume' }, at(20));
    if (!resumed.ok) throw new Error(resumed.error);
    expect(resumed.value.record.status).toBe('active');
    const ended = changeSession(resumed.value.record, { kind: 'end' }, at(30));
    if (!ended.ok) throw new Error(ended.error);
    expect(ended.value.record).toMatchObject({ status: 'ended', endedAt: at(30) });
    expect(changeSession(ended.value.record, { kind: 'resume' }, at(40))).toEqual({
      ok: false,
      error: 'session_ended',
    });
  });

  test('invalid transitions are refused', () => {
    expect(changeSession(session(), { kind: 'resume' }, at(1)).ok).toBe(false);
    expect(changeSession(session({ status: 'paused' }), { kind: 'pause' }, at(1)).ok).toBe(false);
  });

  test('an end before the start (a skewed clock) ends at the start', () => {
    const ended = changeSession(session(), { kind: 'end' }, at(-5));
    expect(ended.ok && ended.value.record.endedAt).toBe(T0);
  });

  test('scene and presence change while open', () => {
    const scene = changeSession(session(), { kind: 'scene', sceneId: id(30) }, at(1));
    expect(scene.ok && scene.value).toMatchObject({
      scene: true,
      record: { currentSceneId: id(30) },
    });
    const present = changeSession(
      session(),
      { kind: 'present', userId: id(3), present: true },
      at(1),
    );
    expect(present.ok && present.value.record.participantUserIds).toEqual([GM, id(3)]);
    expect(changeSession(session(), { kind: 'present', userId: GM, present: true }, at(1)).ok).toBe(
      false,
    );
  });

  test('the authority accepts exactly the device changes', () => {
    const current = session({ version: 3 });
    expect(classifyUpdate(current, { ...current, status: 'paused' })).toEqual({
      ok: true,
      value: 'paused',
    });
    expect(classifyUpdate(current, { ...current, currentSceneId: id(30) })).toEqual({
      ok: true,
      value: 'scene',
    });
    expect(classifyUpdate(current, { ...current, participantUserIds: [] })).toEqual({
      ok: true,
      value: 'none',
    });
    expect(classifyUpdate(current, { ...current, status: 'ended', endedAt: at(9) })).toEqual({
      ok: true,
      value: 'ended',
    });
    expect(classifyUpdate(current, { ...current, number: 9 })).toEqual({ ok: true, value: 'none' });
    expect(classifyUpdate(current, { ...current, startedAt: at(1) }).ok).toBe(false);
    expect(classifyUpdate(current, { ...current, status: 'ended' }).ok).toBe(false);
    expect(classifyUpdate(session({ status: 'ended', endedAt: at(1) }), current).ok).toBe(false);
  });
});

describe('numbering and participants (D-04, D-09)', () => {
  test('one open session, provisional number after the highest', () => {
    const ended = session({ id: id(11), number: 2, status: 'ended', endedAt: at(1) });
    expect(openSessionOf([ended])).toBeUndefined();
    expect(provisionalNumber([ended, session()])).toBe(3);
    expect(openSessionOf([ended, session()])?.id).toBe(id(10));
  });

  test('the starter, then each character owner once', () => {
    expect(
      initialParticipants(GM, [
        { ownerUserId: id(3) },
        { ownerUserId: id(3) },
        { ownerUserId: id(4), deletedAt: T0 },
        { ownerUserId: GM },
      ]),
    ).toEqual([GM, id(3)]);
  });
});

describe('scene context (D-02)', () => {
  const scene = { id: id(30), type: 'scene', name: 'Old Warehouse', summary: '' };
  const district = { id: id(31), type: 'location', name: 'Lower District', summary: '' };
  const merchant = { id: id(32), type: 'npc', name: 'Merchant', summary: 'Nervous' };
  const smuggler = { id: id(33), type: 'npc', name: 'Smuggler', summary: '' };
  const links = [
    { sourceEntityId: id(30), targetEntityId: id(31), kind: 'located_at' },
    { sourceEntityId: id(33), targetEntityId: id(30), kind: 'appears_in' },
    { sourceEntityId: id(32), targetEntityId: id(30), kind: 'appears_in' },
    { sourceEntityId: id(32), targetEntityId: id(31), kind: 'appears_in' },
  ];

  test('location and NPCs present, by name', () => {
    const context = sceneContext(id(30), [scene, district, merchant, smuggler], links);
    expect(context.scene).toEqual(scene);
    expect(context.locations.map((item) => item.name)).toEqual(['Lower District']);
    expect(context.present.map((item) => item.name)).toEqual(['Merchant', 'Smuggler']);
  });

  test('a scene the device does not hold is unavailable, and absent links show nothing', () => {
    expect(sceneContext(id(30), [district], links).scene).toBe('unavailable');
    expect(sceneContext(id(30), [scene], links)).toEqual({ scene, locations: [], present: [] });
    expect(sceneContext(undefined, [scene], links).scene).toBeUndefined();
  });
});

describe('session log (D-03)', () => {
  test('entries (reveals included), rolls, and effects inside the window, in time order', () => {
    const ended = session({ status: 'ended', endedAt: at(60) });
    const lines = sessionLog({
      session: ended,
      entries: [
        entry(),
        entry({ id: id(21), sessionId: id(99) }),
        entry({ id: id(43), kind: 'reveal', text: '', subjectId: id(50), createdAt: at(9) }),
      ],
      rolls: [
        {
          id: id(40),
          name: '1d20',
          result: { modified: 12 },
          rolledAt: at(3),
          visibility: { mode: 'everyone' },
        },
        {
          id: id(41),
          name: 'late',
          result: { modified: 1 },
          rolledAt: at(61),
          visibility: { mode: 'everyone' },
        },
      ],
      effects: [{ id: id(42), name: 'Take damage', appliedAt: at(7) }],
    });
    expect(lines.map((line) => `${line.kind}:${line.id}`)).toEqual([
      `roll:${id(40)}`,
      `entry:${id(20)}`,
      `effect:${id(42)}`,
      `entry:${id(43)}`,
    ]);
  });
});

describe('palette (D-12)', () => {
  const items = [
    { id: 'a', label: 'Add NPC', group: 'Action' },
    { id: 'b', label: 'Reveal handout', group: 'Action' },
    { id: 'c', label: 'Set scene: Old Warehouse', group: 'Scene' },
    { id: 'd', label: 'Merchant', group: 'NPC' },
  ];

  test('every word matches, prefix first, accents ignored', () => {
    expect(matchPalette(items, 'rev').map((item) => item.id)).toEqual(['b']);
    expect(matchPalette(items, 'scene ware').map((item) => item.id)).toEqual(['c']);
    expect(matchPalette(items, 'mérch').map((item) => item.id)).toEqual(['d']);
    expect(matchPalette(items, 'a').map((item) => item.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(matchPalette(items, '').length).toBe(4);
    expect(matchPalette(items, 'zzz')).toEqual([]);
  });
});

describe('records and codecs', () => {
  test('rows round-trip and invalid rows are never guessed', () => {
    const record = session({ currentSceneId: id(30) });
    const row = { id: record.id, ...SESSION_ROW_CODEC.toRow(record) };
    expect(SESSION_ROW_CODEC.fromRow(row)).toEqual(record);
    expect(SESSION_ROW_CODEC.fromRow({ ...row, status: 'ended' })).toBeUndefined();
    expect(SESSION_ROW_CODEC.fromRow({ ...row, visibility_mode: 'gm_only' })).toBeUndefined();
    const note = {
      ...session(),
      type: 'session_gm_note' as const,
      name: 'GM notes',
      visibility: { mode: 'gm_only' as const },
      body: 'Secret door',
    };
    const { number: _n, status: _s, startedAt: _t, participantUserIds: _p, ...plain } = note;
    expect(
      SESSION_NOTE_ROW_CODEC.fromRow({ id: note.id, ...SESSION_NOTE_ROW_CODEC.toRow(plain) }),
    ).toEqual(plain);
    const logged = entry();
    expect(
      SESSION_LOG_ROW_CODEC.fromRow({ id: logged.id, ...SESSION_LOG_ROW_CODEC.toRow(logged) }),
    ).toEqual(logged);
  });

  test('entry kinds (D-10)', () => {
    expect(isValidLogEntry(entry())).toBe(true);
    expect(isValidLogEntry(entry({ text: '  ' }))).toBe(false);
    expect(isValidLogEntry(entry({ kind: 'scene', text: '', subjectId: id(30) }))).toBe(false);
    expect(
      isValidLogEntry(
        entry({ kind: 'scene', text: '', subjectId: id(30), visibility: { mode: 'everyone' } }),
      ),
    ).toBe(true);
    expect(
      isValidLogEntry(entry({ kind: 'status', text: 'started', visibility: { mode: 'everyone' } })),
    ).toBe(true);
    expect(
      isValidLogEntry(
        entry({ kind: 'status', text: 'exploded', visibility: { mode: 'everyone' } }),
      ),
    ).toBe(false);
    expect(isValidLogEntry(entry({ visibility: { mode: 'players', playerIds: [GM] } }))).toBe(
      false,
    );
    expect(isValidLogEntry(entry({ kind: 'reveal', text: '', subjectId: id(50) }))).toBe(true);
    expect(
      isValidLogEntry(
        entry({ kind: 'reveal', text: '', subjectId: id(50), visibility: { mode: 'everyone' } }),
      ),
    ).toBe(false);
  });
});
