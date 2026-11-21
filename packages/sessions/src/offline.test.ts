import { describe, expect, test } from 'bun:test';
import { InMemoryRepository } from '@rpg/contracts/testing';
import {
  SessionLocalRepository,
  SessionLogLocalRepository,
  SessionNotesLocalRepository,
} from './offline.ts';
import type { SessionLogEntryRecord, SessionNoteRecord, SessionRecord } from './records.ts';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const actor = { userId: id(2), campaignId: id(1) };

function setup() {
  let n = 100;
  let minute = 0;
  const options = {
    createId: () => {
      n += 1;
      return id(n);
    },
    clock: () => {
      minute += 1;
      return new Date(Date.parse('2026-11-03T18:00:00.000Z') + minute * 60_000);
    },
  };
  const sessionRows = new InMemoryRepository<SessionRecord>();
  const logRows = new InMemoryRepository<SessionLogEntryRecord>();
  const noteRows = new InMemoryRepository<SessionNoteRecord>();
  const log = new SessionLogLocalRepository(logRows, actor, options);
  return {
    sessions: new SessionLocalRepository(sessionRows, log, actor, options),
    notes: new SessionNotesLocalRepository(noteRows, actor, options),
    log,
  };
}

describe('device session (FR-002, FR-011)', () => {
  test('start, scene, pause, resume, end: each change and its log entry, local first', async () => {
    const { sessions, log } = setup();
    const started = await sessions.start([actor.userId, id(3)]);
    if (!started.ok) throw new Error(started.error.code);
    expect(started.value).toMatchObject({ number: 1, status: 'active', version: 1 });
    expect((await sessions.start([])).ok).toBe(false);
    const sessionId = started.value.id;
    for (const change of [
      { kind: 'scene', sceneId: id(30) },
      { kind: 'pause' },
      { kind: 'resume' },
      { kind: 'end' },
    ] as const) {
      const changed = await sessions.change(sessionId, change);
      if (!changed.ok) throw new Error(changed.error.code);
    }
    const ended = await sessions.get(sessionId);
    expect(ended).toMatchObject({ status: 'ended', version: 5, currentSceneId: id(30) });
    expect((await sessions.open()) === undefined).toBe(true);
    const entries = await log.list(sessionId);
    expect(entries.map((entry) => `${entry.kind}:${entry.text || entry.subjectId}`)).toEqual([
      'status:started',
      `scene:${id(30)}`,
      'status:paused',
      'status:resumed',
      'status:ended',
    ]);
    expect(entries.every((entry) => entry.visibility.mode === 'everyone')).toBe(true);
    expect((await sessions.change(sessionId, { kind: 'resume' })).ok).toBe(false);
    const next = await sessions.start([actor.userId]);
    expect(next.ok && next.value.number).toBe(2);
  });

  test('log notes are GM-only unless shown, and bounded', async () => {
    const { log } = setup();
    const hidden = await log.addNote(id(10), 'Crates hide a door', false);
    const shown = await log.addNote(id(10), 'The bell rings', true);
    expect(hidden.ok && hidden.value.visibility).toEqual({ mode: 'gm_only' });
    expect(shown.ok && shown.value.visibility).toEqual({ mode: 'everyone' });
    expect((await log.addNote(id(10), ' ', true)).ok).toBe(false);
    expect((await log.addNote(id(10), 'x'.repeat(501), true)).ok).toBe(false);
  });

  test('GM notes: first save inserts, later saves name their version, a stale one conflicts', async () => {
    const { notes } = setup();
    const first = await notes.save(id(10), 'Secret door', null);
    if (!first.ok) throw new Error(first.error.code);
    const second = await notes.save(id(10), 'Secret door, guarded', first.value.version);
    expect(second.ok && second.value.version).toBe(2);
    const stale = await notes.save(id(10), 'Overwrite?', 1);
    expect(stale.ok).toBe(false);
    expect((await notes.get(id(10)))?.body).toBe('Secret door, guarded');
  });
});
