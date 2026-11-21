import { describe, expect, test } from 'bun:test';
import { submitVisibilityChange, visibilityUrl } from './visibility-api.ts';
import {
  mayShowRevealControls,
  outcomeMessage,
  outcomeOf,
  parseVisibility,
  recipientsOf,
  requestFor,
  revealablePlayers,
} from './visibility-model.ts';

const CASEY = '00000000-0000-4000-8000-0000000000c1';
const ROWAN = '00000000-0000-4000-8000-0000000000d1';
const GONE = '00000000-0000-4000-8000-0000000000e1';
const member = (id: string, username: string, role: string) => ({
  user: { id, username },
  role,
});

describe('role hint', () => {
  test('only GM roles are offered the controls; everything else is hidden', () => {
    expect(['owner', 'gm', 'assistant_gm'].map(mayShowRevealControls)).toEqual([true, true, true]);
    for (const role of ['player', 'observer', '', 'admin', undefined]) {
      expect(mayShowRevealControls(role)).toBe(false);
    }
  });
});

describe('member picker', () => {
  test('offers current players only: no GM roles, no observers, no duplicates', () => {
    const options = revealablePlayers([
      member(ROWAN, 'rowan', 'player'),
      member(CASEY, 'casey', 'player'),
      member('00000000-0000-4000-8000-0000000000b1', 'gm', 'gm'),
      member('00000000-0000-4000-8000-0000000000f1', 'watcher', 'observer'),
      member(CASEY, 'casey', 'player'),
    ]);
    expect(options.map((option) => option.username)).toEqual(['casey', 'rowan']);
  });

  test('a removed member is absent from the list, so it is never offered', () => {
    const options = revealablePlayers([member(CASEY, 'casey', 'player')]);
    expect(options.map((option) => option.id)).toEqual([CASEY]);
  });

  test('a granted id that is no longer a member is shown as former and stays removable', () => {
    const recipients = recipientsOf({ mode: 'players', playerIds: [CASEY, GONE] }, [
      member(CASEY, 'casey', 'player'),
    ]);
    expect(recipients).toEqual([
      { id: CASEY, label: 'casey', current: true },
      { id: GONE, label: 'Former member', current: false },
    ]);
    expect(recipientsOf({ mode: 'everyone' }, [])).toEqual([]);
  });
});

describe('request bodies', () => {
  test('carry operation, target and expected version only: never an actor, role or user', () => {
    const body = requestFor({ kind: 'reveal_players', playerIds: [CASEY, CASEY, ROWAN] }, 3);
    expect(body).toEqual({
      operation: 'reveal',
      target: { mode: 'players', playerIds: [CASEY, ROWAN] },
      expectedVersion: 3,
    });
    expect(requestFor({ kind: 'unreveal_players', playerIds: [CASEY] }, 4).operation).toBe(
      'unreveal',
    );
    expect(requestFor({ kind: 'reveal_everyone' }, 1).target).toEqual({ mode: 'everyone' });
    expect(requestFor({ kind: 'hide_everyone' }, 1)).toEqual({
      operation: 'unreveal',
      target: { mode: 'everyone' },
      expectedVersion: 1,
    });
    for (const intent of [
      { kind: 'reveal_everyone' },
      { kind: 'hide_everyone' },
      { kind: 'reveal_players', playerIds: [CASEY] },
    ] as const) {
      expect(JSON.stringify(requestFor(intent, 1))).not.toMatch(/role|actor|userId|campaignId/i);
    }
  });
});

describe('outcomes fail closed', () => {
  test('200 needs a canonical visibility, an integer version and a boolean changed', () => {
    expect(
      outcomeOf(200, {
        visibility: { mode: 'players', playerIds: [CASEY] },
        version: 2,
        changed: true,
      }),
    ).toEqual({
      kind: 'applied',
      visibility: { mode: 'players', playerIds: [CASEY] },
      version: 2,
      changed: true,
    });
    for (const body of [
      undefined,
      {},
      { visibility: { mode: 'players', playerIds: [] }, version: 2, changed: true },
      { visibility: { mode: 'players', playerIds: ['x'] }, version: 2, changed: true },
      { visibility: { mode: 'weird' }, version: 2, changed: true },
      { visibility: { mode: 'gm_only' }, version: 1.5, changed: true },
      { visibility: { mode: 'gm_only' }, version: 2 },
    ]) {
      expect(outcomeOf(200, body).kind).toBe('failed');
    }
    expect(parseVisibility({ mode: 'gm_only', playerIds: [CASEY] })).toEqual({ mode: 'gm_only' });
  });

  test('maps conflict, target problems, safe denial, sign-out and unknown statuses', () => {
    expect(outcomeOf(409, { code: 'version_conflict' })).toEqual({ kind: 'conflict' });
    expect(outcomeOf(400, { details: { reason: 'target_not_member' } })).toEqual({
      kind: 'rejected',
      reason: 'target_not_member',
    });
    expect(outcomeOf(400, undefined)).toEqual({ kind: 'rejected', reason: '' });
    expect(outcomeOf(404, { code: 'not_found_or_forbidden' })).toEqual({ kind: 'unavailable' });
    expect(outcomeOf(401, undefined).kind).toBe('signed_out');
    expect(outcomeOf(403, undefined).kind).toBe('signed_out');
    expect(outcomeOf(500, undefined).kind).toBe('failed');
    expect(outcomeOf(204, undefined).kind).toBe('failed');
  });

  test('the denial copy never says whether the record exists', () => {
    const message = outcomeMessage({ kind: 'unavailable' });
    expect(message).toContain('not available');
    expect(message).toContain('cannot change');
  });
});

describe('submitVisibilityChange', () => {
  const target = { campaignId: 'c-1', resourceClass: 'fixture_note', resourceId: 'r 1' };

  test('PATCHes the generic route with credentials and a body free of actor fields', async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const outcome = await submitVisibilityChange(
      target,
      requestFor({ kind: 'reveal_players', playerIds: [CASEY] }, 1),
      async (url, init) => {
        seen = { url, init };
        return new Response(
          JSON.stringify({
            visibility: { mode: 'players', playerIds: [CASEY] },
            version: 2,
            changed: true,
          }),
          { status: 200 },
        );
      },
    );
    expect(outcome.kind).toBe('applied');
    expect(seen?.url).toBe(visibilityUrl(target));
    expect(seen?.url).toBe('/campaigns/c-1/resources/fixture_note/r%201/visibility');
    expect(seen?.init.method).toBe('PATCH');
    expect(seen?.init.credentials).toBe('include');
    expect(JSON.parse(String(seen?.init.body))).toEqual({
      operation: 'reveal',
      target: { mode: 'players', playerIds: [CASEY] },
      expectedVersion: 1,
    });
  });

  test('network failure and unreadable bodies fail closed', async () => {
    const hide = requestFor({ kind: 'hide_everyone' }, 1);
    const offline = await submitVisibilityChange(target, hide, async () => {
      throw new Error('offline');
    });
    expect(offline.kind).toBe('failed');
    const garbage = await submitVisibilityChange(
      target,
      hide,
      async () => new Response('not json', { status: 200 }),
    );
    expect(garbage.kind).toBe('failed');
  });
});
