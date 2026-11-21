import { describe, expect, test } from 'bun:test';
import { ResourcePolicyRegistry } from '@rpg/authorization';
import type { ActorRef, Role } from '@rpg/contracts';
import {
  CAMPAIGN,
  CASEY,
  GM,
  MemoryNoteAdapter,
  NOTE,
  notePolicy,
  OTHER_CAMPAIGN,
  SECRET,
} from '../authorization/test-fixture.ts';
import { AuditTargetAccess } from './target-access.ts';

/** Feature 06 task 03: per-event read decisions over feature 04 (no database). */

function setup() {
  const registry = new ResourcePolicyRegistry({ requireVisibilityAdapters: true });
  const notes = new MemoryNoteAdapter(NOTE);
  const secrets = new MemoryNoteAdapter(SECRET);
  registry.register(notePolicy(NOTE, false), notes);
  registry.register(notePolicy(SECRET, true), secrets);
  const access = new AuditTargetAccess({ registry });
  const actor = (userId: string, role: Role): ActorRef => ({ userId, campaignId: CAMPAIGN, role });
  return { notes, secrets, access, actor };
}

const everyone = { visibility: { mode: 'everyone' as const } };

describe('AuditTargetAccess', () => {
  test('the GM-private store narrows every target to GM-only, independent of the route gate', async () => {
    const { notes, access, actor } = setup();
    const id = notes.put({ id: crypto.randomUUID(), visibility: { mode: 'everyone' } }).id;
    const occurrence = { targetType: NOTE, targetId: id, snapshot: everyone };
    expect(await access.readerFor(actor(CASEY, 'player'), 'campaign').permits(occurrence)).toBe(
      true,
    );
    expect(await access.readerFor(actor(CASEY, 'player'), 'private').permits(occurrence)).toBe(
      false,
    );
    expect(await access.readerFor(actor(GM, 'gm'), 'private').permits(occurrence)).toBe(true);
  });

  test('undeclared classes, missing records, foreign facts, and bad snapshots fail closed', async () => {
    const { notes, access, actor } = setup();
    const gm = access.readerFor(actor(GM, 'owner'), 'campaign');
    const local = notes.put({ id: crypto.randomUUID(), visibility: { mode: 'everyone' } }).id;
    const foreign = notes.put({
      id: crypto.randomUUID(),
      campaignId: OTHER_CAMPAIGN,
      visibility: { mode: 'everyone' },
    }).id;
    expect(await gm.permits({ targetType: NOTE, targetId: local, snapshot: everyone })).toBe(true);
    for (const occurrence of [
      { targetType: 'undeclared', targetId: local, snapshot: everyone },
      { targetType: NOTE, targetId: crypto.randomUUID(), snapshot: everyone },
      { targetType: NOTE, targetId: foreign, snapshot: everyone },
      { targetType: NOTE, targetId: local, snapshot: undefined },
      { targetType: NOTE, targetId: local, snapshot: { visibility: { mode: 'nobody' } } },
      { targetType: NOTE, targetId: local, snapshot: { ...everyone, extra: true } },
    ]) {
      expect(await gm.permits(occurrence)).toBe(false);
    }
  });

  test('current visibility and the stored snapshot must both admit the reader', async () => {
    const { notes, access, actor } = setup();
    const player = access.readerFor(actor(CASEY, 'player'), 'campaign');
    const hiddenNow = notes.put({ id: crypto.randomUUID(), visibility: { mode: 'gm_only' } }).id;
    const visibleNow = notes.put({ id: crypto.randomUUID(), visibility: { mode: 'everyone' } }).id;
    expect(
      await player.permits({ targetType: NOTE, targetId: hiddenNow, snapshot: everyone }),
    ).toBe(false);
    expect(
      await player.permits({
        targetType: NOTE,
        targetId: visibleNow,
        snapshot: { visibility: { mode: 'gm_only' } },
      }),
    ).toBe(false);
    expect(
      await player.permits({
        targetType: NOTE,
        targetId: visibleNow,
        snapshot: { visibility: { mode: 'players', playerIds: [CASEY] } },
      }),
    ).toBe(true);
  });

  test('an author-private class denies a GM role that is not the author', async () => {
    const { secrets, access, actor } = setup();
    const id = secrets.put({
      id: crypto.randomUUID(),
      visibility: { mode: 'everyone' },
      authorUserId: CASEY,
    }).id;
    const occurrence = {
      targetType: SECRET,
      targetId: id,
      snapshot: { visibility: { mode: 'gm_only' as const } },
    };
    for (const store of ['campaign', 'private'] as const) {
      expect(await access.readerFor(actor(GM, 'gm'), store).permits(occurrence)).toBe(false);
      expect(await access.readerFor(actor(GM, 'owner'), store).permits(occurrence)).toBe(false);
    }
    // A snapshot naming another author never overrides the record's current author.
    expect(
      await access.readerFor(actor(GM, 'gm'), 'campaign').permits({
        ...occurrence,
        snapshot: { visibility: { mode: 'gm_only' }, authorUserId: GM },
      }),
    ).toBe(false);
  });
});
