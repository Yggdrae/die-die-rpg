import { describe, expect, test } from 'bun:test';
import type { Visibility } from '@rpg/contracts';
import {
  AuthorityMutationService,
  InMemoryLongTextHoldRepository,
  InMemoryMutationReceiptStore,
  LongTextHoldService,
  MutationApplierRegistry,
  SyncBootstrapService,
} from '@rpg/sync';
import {
  CAMPAIGN,
  CASEY,
  fixtureApp,
  fixtureContext,
  GM,
  NOTE,
  noteId,
  OBSERVER,
  ORIGIN,
  ROWAN,
  SECRET,
  STRANGER,
  sessionCookie,
} from '../authorization/test-fixture.ts';
import { registerSyncRoutes } from './routes.ts';

/**
 * Long-text holds name a record and disclose its holder. Feature 04 decides `update` on that
 * record before any hold is read or written; every denial is the non-member 404.
 */
function setup() {
  const context = fixtureContext();
  const { app } = fixtureApp(context);
  const access = {
    resolve: async (userId: string, campaignId: string) => {
      const resolved = await context.members.resolve(userId, campaignId);
      return resolved.ok ? resolved.value : undefined;
    },
  };
  registerSyncRoutes(
    app,
    {
      access,
      bootstrap: new SyncBootstrapService(access, 'http://localhost:8080', {
        issue: async () => 'signed-token',
      }),
      mutations: new AuthorityMutationService(
        access,
        new MutationApplierRegistry(),
        new InMemoryMutationReceiptStore(),
      ),
      holds: new LongTextHoldService(new InMemoryLongTextHoldRepository()),
      records: context.access,
      watermarks: { acknowledge: async () => undefined, replicaDropped: async () => undefined },
    },
    { allowedOrigin: ORIGIN },
  );
  // GM-only note, a note revealed to everyone, and Casey's author-private note.
  context.notes.put({ id: noteId(1), visibility: { mode: 'gm_only' } });
  context.notes.put({ id: noteId(2), visibility: { mode: 'everyone' } });
  context.secrets.put({
    id: noteId(3),
    visibility: { mode: 'players', playerIds: [CASEY] },
    authorUserId: CASEY,
  });
  const hold = (
    userId: string,
    action: 'acquire' | 'takeover' | 'renew' | 'release',
    field: { resourceClass: string; recordId: string },
    expectedVersion?: number,
  ) =>
    app.inject({
      method: 'POST',
      url: `/sync/holds/${CAMPAIGN}/${action}`,
      headers: { cookie: sessionCookie(userId), origin: ORIGIN },
      payload: {
        ...field,
        fieldPath: 'body',
        ...(expectedVersion === undefined ? {} : { expectedVersion }),
      },
    });
  return { app, context, hold };
}

const GM_NOTE = { resourceClass: NOTE, recordId: noteId(1) };
const PUBLIC_NOTE = { resourceClass: NOTE, recordId: noteId(2) };
const CASEY_SECRET = { resourceClass: SECRET, recordId: noteId(3) };
const MISSING = { resourceClass: NOTE, recordId: noteId(99) };

describe('long-text hold access', () => {
  test('a GM role holds a GM-only record it may update', async () => {
    const { app, hold } = setup();
    const acquired = await hold(GM, 'acquire', GM_NOTE);
    expect(acquired.statusCode).toBe(200);
    expect(acquired.json()).toMatchObject({ acquired: true, hold: { holderUserId: GM } });
    await app.close();
  });

  test('a player who may only read gets the missing-record response, never the holder', async () => {
    const { app, hold } = setup();
    expect((await hold(GM, 'acquire', PUBLIC_NOTE)).statusCode).toBe(200);
    const missing = await hold(CASEY, 'acquire', MISSING);
    expect(missing.statusCode).toBe(404);
    for (const action of ['acquire', 'takeover'] as const) {
      const denied = await hold(CASEY, action, PUBLIC_NOTE);
      expect(denied.statusCode).toBe(404);
      expect(denied.body).toBe(missing.body);
      expect(denied.body).not.toContain(GM);
    }
    await app.close();
  });

  test('an author-private record cannot be held, taken over or probed by a GM role', async () => {
    const { app, hold } = setup();
    const acquired = await hold(CASEY, 'acquire', CASEY_SECRET);
    expect(acquired.statusCode).toBe(200);
    const version = acquired.json().hold.version;
    const missing = await hold(GM, 'acquire', { resourceClass: SECRET, recordId: noteId(98) });
    for (const userId of [GM, ROWAN]) {
      for (const action of ['acquire', 'takeover'] as const) {
        const denied = await hold(userId, action, CASEY_SECRET);
        expect(denied.statusCode).toBe(404);
        expect(denied.body).toBe(missing.body);
        expect(denied.body).not.toContain(CASEY);
      }
      for (const action of ['renew', 'release'] as const) {
        const denied = await hold(userId, action, CASEY_SECRET, version);
        expect(denied.statusCode).toBe(404);
        expect(denied.body).toBe(missing.body);
      }
    }
    // The author's hold survived every attempt.
    const renewed = await hold(CASEY, 'renew', CASEY_SECRET, version);
    expect(renewed.statusCode).toBe(200);
    expect(renewed.json()).toMatchObject({ holderUserId: CASEY, version });
    await app.close();
  });

  test('observers, other campaigns and unknown classes are indistinguishable from a miss', async () => {
    const { app, hold } = setup();
    expect((await hold(GM, 'acquire', GM_NOTE)).statusCode).toBe(200);
    const missing = await hold(GM, 'acquire', MISSING);
    const attempts = [
      await hold(OBSERVER, 'acquire', PUBLIC_NOTE),
      await hold(STRANGER, 'acquire', GM_NOTE),
      await hold(GM, 'acquire', { resourceClass: 'unregistered_class', recordId: noteId(1) }),
      await hold(CASEY, 'takeover', GM_NOTE),
    ];
    for (const denied of attempts) {
      expect(denied.statusCode).toBe(404);
      expect(denied.body).toBe(missing.body);
      expect(denied.body).not.toContain(GM);
    }
    await app.close();
  });

  test('a revoked holder can no longer renew or release', async () => {
    const { app, context, hold } = setup();
    const acquired = await hold(GM, 'acquire', GM_NOTE);
    const version = acquired.json().hold.version;
    context.members.revokeAfter(0);
    expect((await hold(GM, 'renew', GM_NOTE, version)).statusCode).toBe(404);
    expect((await hold(GM, 'release', GM_NOTE, version)).statusCode).toBe(404);
    await app.close();
  });

  test('a record with malformed stored Visibility denies like a miss instead of failing', async () => {
    const { app, context, hold } = setup();
    const corrupt = { resourceClass: SECRET, recordId: noteId(4) };
    context.secrets.put({
      id: corrupt.recordId,
      // Wrong field name for a players target: data a buggy owner adapter could return.
      visibility: { mode: 'players', targets: [CASEY] } as unknown as Visibility,
      authorUserId: CASEY,
    });
    const missing = await hold(CASEY, 'acquire', MISSING);
    for (const userId of [CASEY, GM]) {
      const denied = await hold(userId, 'acquire', corrupt);
      expect(denied.statusCode).toBe(404);
      expect(denied.body).toBe(missing.body);
    }
    expect(context.denials).toContainEqual([SECRET, 'invalid_facts']);
    await app.close();
  });
});
