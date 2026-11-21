import { describe, expect, test } from 'bun:test';
import type { FastifyInstance } from 'fastify';
import {
  CAMPAIGN,
  CASEY,
  fixtureApp,
  GM,
  NOTE,
  noteId,
  OBSERVER,
  ORIGIN,
  OUTSIDER,
  ROWAN,
  registerFixtureContentRoutes,
  sessionCookie,
} from './test-fixture.ts';

/**
 * Feature 04 task 06 acceptance, server side. Class `fixture_note` is the invented test class
 * (no production content class exists). Sync delivery is proved by task 05/07, not here: these
 * tests show what the API (and therefore any row-producing read) returns per actor.
 */

const url = (resourceId: string) =>
  `/campaigns/${CAMPAIGN}/resources/${NOTE}/${resourceId}/visibility`;
const readUrl = (resourceId: string) => `/campaigns/${CAMPAIGN}/resources/${NOTE}/${resourceId}`;
const listUrl = `/campaigns/${CAMPAIGN}/resources/${NOTE}`;

function patch(app: FastifyInstance, userId: string | undefined, payload: unknown) {
  return app.inject({
    method: 'PATCH',
    url: url(noteId(1)),
    headers: {
      origin: ORIGIN,
      ...(userId === undefined ? {} : { cookie: sessionCookie(userId) }),
    },
    payload: payload as object,
  });
}

function get(app: FastifyInstance, userId: string, path: string) {
  return app.inject({ method: 'GET', url: path, headers: { cookie: sessionCookie(userId) } });
}

function seeded() {
  const fixture = fixtureApp();
  registerFixtureContentRoutes(fixture.app, fixture);
  fixture.notes.put({ id: noteId(1), visibility: { mode: 'gm_only' } });
  return fixture;
}

const body = (operation: 'reveal' | 'unreveal', playerIds: string[], expectedVersion: number) => ({
  operation,
  target: { mode: 'players', playerIds },
  expectedVersion,
});

describe('Task 06: player A receives a reveal and player B receives no row or payload', () => {
  test('reveal to Casey: Casey gets the record and the list row; Rowan gets nothing', async () => {
    const { app } = seeded();
    const rowanListBefore = await get(app, ROWAN, listUrl);
    const rowanReadBefore = await get(app, ROWAN, readUrl(noteId(1)));

    const revealed = await patch(app, GM, body('reveal', [CASEY], 1));
    expect(revealed.statusCode).toBe(200);

    const caseyRead = await get(app, CASEY, readUrl(noteId(1)));
    expect(caseyRead.statusCode).toBe(200);
    expect(caseyRead.json()).toMatchObject({ id: noteId(1) });
    const caseyList = (await get(app, CASEY, listUrl)).json();
    expect(caseyList.items.map((item: { id: string }) => item.id)).toEqual([noteId(1)]);
    expect(caseyList.total).toBe(1);

    // Rowan: the same bytes as before the reveal, and as a record that does not exist.
    const rowanRead = await get(app, ROWAN, readUrl(noteId(1)));
    const missing = await get(app, ROWAN, readUrl(noteId(999)));
    expect(rowanRead.statusCode).toBe(404);
    expect(rowanRead.body).toBe(rowanReadBefore.body);
    expect(rowanRead.body).toBe(missing.body);
    const rowanList = await get(app, ROWAN, listUrl);
    expect(rowanList.body).toBe(rowanListBefore.body);
    expect(JSON.parse(rowanList.body)).toEqual({ items: [], total: 0 });
    expect(rowanList.body).not.toContain(noteId(1));
    await app.close();
  });
});

describe('Task 06: removing the last target stores gm_only and removes future access', () => {
  test('un-reveal of the last recipient stores gm_only; Casey is denied; GM still reads', async () => {
    const { app, notes } = seeded();
    await patch(app, GM, body('reveal', [CASEY], 1));
    expect((await get(app, CASEY, readUrl(noteId(1)))).statusCode).toBe(200);

    const removed = await patch(app, GM, body('unreveal', [CASEY], 2));
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toMatchObject({ visibility: { mode: 'gm_only' }, changed: true });
    expect(notes.rows.get(noteId(1))?.visibility).toEqual({ mode: 'gm_only' });

    const caseyRead = await get(app, CASEY, readUrl(noteId(1)));
    expect(caseyRead.statusCode).toBe(404);
    const caseyList = await get(app, CASEY, listUrl);
    expect(JSON.parse(caseyList.body)).toEqual({ items: [], total: 0 });
    expect(caseyList.body).not.toContain(noteId(1));
    expect((await get(app, GM, readUrl(noteId(1)))).statusCode).toBe(200);
    await app.close();
  });

  test('removing one of two recipients keeps the other, and never stores an empty grant', async () => {
    const { app, notes } = seeded();
    await patch(app, GM, body('reveal', [CASEY, ROWAN], 1));
    const one = await patch(app, GM, body('unreveal', [CASEY], 2));
    expect(one.json().visibility).toEqual({ mode: 'players', playerIds: [ROWAN] });
    const last = await patch(app, GM, body('unreveal', [ROWAN], 3));
    expect(last.json().visibility).toEqual({ mode: 'gm_only' });
    expect(JSON.stringify(notes.rows.get(noteId(1))?.visibility)).not.toContain('playerIds');
    await app.close();
  });
});

describe('Task 06: unauthorized users cannot produce a visibility mutation by direct request', () => {
  test('player, observer, outsider and anonymous reveal and un-reveal attempts change nothing', async () => {
    const { app, notes, audit } = seeded();
    await patch(app, GM, body('reveal', [CASEY], 1));
    const writesBefore = notes.writes;
    const auditBefore = audit.submissions.length;

    for (const actor of [CASEY, ROWAN, OBSERVER, OUTSIDER, undefined]) {
      for (const payload of [
        body('reveal', [ROWAN], 2),
        body('unreveal', [CASEY], 2),
        { operation: 'reveal', target: { mode: 'everyone' }, expectedVersion: 2 },
        { operation: 'unreveal', target: { mode: 'everyone' }, expectedVersion: 2 },
      ]) {
        const response = await patch(app, actor, payload);
        expect(response.statusCode).toBe(actor === undefined ? 401 : 404);
      }
    }
    expect(notes.rows.get(noteId(1))).toMatchObject({
      version: 2,
      visibility: { mode: 'players', playerIds: [CASEY] },
    });
    expect(notes.writes).toBe(writesBefore);
    expect(audit.submissions).toHaveLength(auditBefore);
    await app.close();
  });

  test('a UI-hidden control is not a control: a player PATCH is denied like a missing record', async () => {
    const { app } = seeded();
    const denied = await patch(app, CASEY, body('reveal', [CASEY], 1));
    const missing = await app.inject({
      method: 'PATCH',
      url: url(noteId(999)),
      headers: { origin: ORIGIN, cookie: sessionCookie(CASEY) },
      payload: body('reveal', [CASEY], 1),
    });
    expect(denied.statusCode).toBe(404);
    expect(denied.body).toBe(missing.body);
    await app.close();
  });
});

describe('Task 06: conflict and target errors reach the UI as distinct, safe responses', () => {
  test('a stale version is a 409 for an authorized GM and changes nothing', async () => {
    const { app, notes } = seeded();
    await patch(app, GM, body('reveal', [CASEY], 1));
    const stale = await patch(app, GM, body('reveal', [ROWAN], 1));
    expect(stale.statusCode).toBe(409);
    expect(notes.rows.get(noteId(1))?.visibility).toEqual({ mode: 'players', playerIds: [CASEY] });
    await app.close();
  });

  test('revealing to a non-member is a 400 with details.reason the picker maps to a refresh', async () => {
    const { app } = seeded();
    const response = await patch(app, GM, body('reveal', [OUTSIDER], 1));
    expect(response.statusCode).toBe(400);
    expect(response.json().details).toEqual({ reason: 'target_not_member' });
    await app.close();
  });
});
