import { describe, expect, test } from 'bun:test';
import type { ActorRef } from '@rpg/contracts';
import { ContentDraftStore, MemoryDraftStorage } from './draft-store.ts';
import { type FetchLike, httpHoldApi } from './hold-api.ts';
import {
  CONTENT_SESSION_QUICK_ACTIONS,
  type QuickCreateRequest,
  registerQuickCreateHost,
} from './session-quick-actions.ts';

/** Feature 16 task 12: D-17 draft store, hold client, and D-14 session quick actions. */

const CAMPAIGN = '00000000-0000-4000-8000-0000000016c1';
const OTHER = '00000000-0000-4000-8000-0000000016c2';
const USER = '00000000-0000-4000-8000-0000000016a1';
const RECORD = '00000000-0000-4000-8000-0000000016d1';
const key = (campaignId: string, fieldPath = 'description') => ({
  campaignId,
  resourceClass: 'campaign_entity',
  recordId: RECORD,
  fieldPath,
});

describe('device draft store (D-17)', () => {
  test('keyed by campaign/class/record/field and per user; never shared', () => {
    const storage = new MemoryDraftStorage();
    const mine = new ContentDraftStore(USER, storage, () => new Date('2026-10-29T12:00:00Z'));
    const theirs = new ContentDraftStore(OTHER, storage);
    mine.put(key(CAMPAIGN), 'unsaved text');
    expect(mine.get(key(CAMPAIGN))).toEqual({
      text: 'unsaved text',
      savedAt: '2026-10-29T12:00:00.000Z',
    });
    expect(mine.get(key(CAMPAIGN, 'body'))).toBeUndefined();
    expect(theirs.get(key(CAMPAIGN))).toBeUndefined();
    mine.delete(key(CAMPAIGN));
    expect(mine.get(key(CAMPAIGN))).toBeUndefined();
  });

  test('the feature 03 purge removes one campaign; sign-out clears the user', async () => {
    const storage = new MemoryDraftStorage();
    const drafts = new ContentDraftStore(USER, storage);
    const other = new ContentDraftStore(OTHER, storage);
    drafts.put(key(CAMPAIGN), 'a');
    drafts.put(key(OTHER), 'b');
    other.put(key(CAMPAIGN), 'c');
    await drafts.replicaPurged({
      campaignId: CAMPAIGN,
      replicaId: 'r',
      reason: 'access_revoked',
      purgedAt: '2026-10-29T12:00:00Z',
    });
    expect(drafts.get(key(CAMPAIGN))).toBeUndefined();
    expect(drafts.get(key(OTHER))?.text).toBe('b');
    drafts.clear();
    expect(drafts.get(key(OTHER))).toBeUndefined();
    expect(other.get(key(CAMPAIGN))?.text).toBe('c');
  });

  test('a broken or missing storage never throws', () => {
    const broken = new ContentDraftStore(USER, {
      length: 1,
      key: () => {
        throw new Error('blocked');
      },
      getItem: () => '{not json',
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    });
    broken.put(key(CAMPAIGN), 'x');
    expect(broken.get(key(CAMPAIGN))).toBeUndefined();
    broken.clear();
    const none = new ContentDraftStore(USER, undefined);
    none.put(key(CAMPAIGN), 'x');
    expect(none.get(key(CAMPAIGN))).toBeUndefined();
  });
});

describe('hold client', () => {
  const field = { resourceClass: 'campaign_entity', recordId: RECORD, fieldPath: 'description' };
  const hold = {
    ...field,
    campaignId: CAMPAIGN,
    holderUserId: USER,
    holderSessionId: 's',
    acquiredAt: 'x',
    renewedAt: 'x',
    expiresAt: 'x',
    version: 2,
  };
  const reply =
    (status: number, body: unknown, seen: { url: string; body: unknown }[] = []): FetchLike =>
    async (url, init) => {
      seen.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify(body), { status });
    };

  test('acquire maps held, busy, and failures (offline = unavailable)', async () => {
    const seen: { url: string; body: unknown }[] = [];
    expect(
      await httpHoldApi(reply(200, { acquired: true, hold }, seen)).acquire(CAMPAIGN, field),
    ).toEqual({ kind: 'held', hold });
    expect(seen[0]).toEqual({ url: `/sync/holds/${CAMPAIGN}/acquire`, body: field });
    expect(
      await httpHoldApi(reply(200, { acquired: false, heldBy: USER, expiresAt: 'x' })).acquire(
        CAMPAIGN,
        field,
      ),
    ).toEqual({ kind: 'busy', heldBy: USER, expiresAt: 'x' });
    expect(await httpHoldApi(reply(404, {})).takeover(CAMPAIGN, field)).toEqual({
      kind: 'unavailable',
    });
    const offline: FetchLike = async () => {
      throw new TypeError('Failed to fetch');
    };
    expect(await httpHoldApi(offline).acquire(CAMPAIGN, field)).toEqual({ kind: 'unavailable' });
  });

  test('renew: 409 (taken over or expired) is lost; the body names the version', async () => {
    const seen: { url: string; body: unknown }[] = [];
    expect(await httpHoldApi(reply(200, hold, seen)).renew(CAMPAIGN, field, 2)).toEqual({
      kind: 'held',
      hold,
    });
    expect(seen[0]?.body).toEqual({ ...field, expectedVersion: 2 });
    expect(await httpHoldApi(reply(409, {})).renew(CAMPAIGN, field, 2)).toEqual({ kind: 'lost' });
    expect(await httpHoldApi(reply(503, {})).renew(CAMPAIGN, field, 2)).toEqual({
      kind: 'unavailable',
    });
  });
});

describe('session quick actions (D-14, frozen SessionQuickAction)', () => {
  const actor: ActorRef = { userId: USER, campaignId: CAMPAIGN, role: 'gm' };
  const addNpc = CONTENT_SESSION_QUICK_ACTIONS.find((action) => action.id === 'content.add_npc');

  test('the actions implement the frozen shape with no input', () => {
    expect(CONTENT_SESSION_QUICK_ACTIONS.map((action) => [action.id, action.label])).toEqual([
      ['content.add_npc', 'Add NPC'],
      ['content.add_note', 'Add note'],
    ]);
    expect(addNpc?.invoke.length).toBe(1);
  });

  test('invoke opens the host overlay and resolves on save and on cancel', async () => {
    const requests: QuickCreateRequest[] = [];
    const unregister = registerQuickCreateHost((request) => requests.push(request));
    const saved = addNpc?.invoke({ actor, sessionId: RECORD });
    expect(requests[0]?.entry.type).toBe('npc');
    expect(requests[0]?.actor).toEqual(actor);
    requests[0]?.close('saved');
    await expect(saved).resolves.toBeUndefined();

    const cancelled = addNpc?.invoke({ actor, sessionId: RECORD });
    requests[1]?.close('cancelled');
    requests[1]?.close('saved');
    await expect(cancelled).resolves.toBeUndefined();
    unregister();
  });

  test('with no host, or a failing host, invoke resolves and never throws', async () => {
    await expect(addNpc?.invoke({ actor, sessionId: RECORD })).resolves.toBeUndefined();
    const unregister = registerQuickCreateHost(() => {
      throw new Error('overlay failed');
    });
    await expect(addNpc?.invoke({ actor, sessionId: RECORD })).resolves.toBeUndefined();
    unregister();
  });
});
