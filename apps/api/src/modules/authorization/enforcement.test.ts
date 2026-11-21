import { describe, expect, test } from 'bun:test';
import { runVisibilityAdapterContract } from '@rpg/authorization';
import type { FastifyInstance } from 'fastify';
import { sendSafeDenial, UnsanctionedContentRouteError } from './index.ts';
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
  OTHER_CAMPAIGN,
  OUTSIDER,
  ROWAN,
  registerFixtureContentRoutes,
  SECRET,
  STRANGER,
  sessionCookie,
} from './test-fixture.ts';

const MISSING = noteId(999);

function visibilityUrl(resourceId: string, resourceClass = NOTE, campaignId = CAMPAIGN): string {
  return `/campaigns/${campaignId}/resources/${resourceClass}/${resourceId}/visibility`;
}

function patch(
  app: FastifyInstance,
  userId: string | undefined,
  url: string,
  payload: unknown,
  headers: Record<string, string> = {},
) {
  return app.inject({
    method: 'PATCH',
    url,
    headers: {
      origin: ORIGIN,
      ...(userId === undefined ? {} : { cookie: sessionCookie(userId) }),
      ...headers,
    },
    payload: payload as object,
  });
}

function get(app: FastifyInstance, userId: string | undefined, url: string) {
  return app.inject({
    method: 'GET',
    url,
    headers: userId === undefined ? {} : { cookie: sessionCookie(userId) },
  });
}

const reveal = (extra: object = {}) => ({
  operation: 'reveal',
  target: { mode: 'players', playerIds: [CASEY] },
  expectedVersion: 1,
  ...extra,
});

/** Everything a client can observe about a response. */
function wire(response: { statusCode: number; headers: object; body: string }) {
  const { date: _date, ...headers } = response.headers as Record<string, unknown>;
  return JSON.stringify({ status: response.statusCode, headers, body: response.body });
}

function seeded() {
  const fixture = fixtureApp();
  registerFixtureContentRoutes(fixture.app, fixture);
  fixture.notes.put({ id: noteId(1), visibility: { mode: 'gm_only' } });
  fixture.notes.put({ id: noteId(2), visibility: { mode: 'everyone' } });
  fixture.notes.put({ id: noteId(3), visibility: { mode: 'players', playerIds: [CASEY] } });
  fixture.notes.put({ id: noteId(4), visibility: { mode: 'gm_only' } });
  fixture.notes.put({ id: noteId(5), visibility: { mode: 'players', playerIds: [ROWAN] } });
  return fixture;
}

describe('PATCH visibility: Changing Visibility (_bdd.md) through Fastify', () => {
  test('GM reveals to a named player; the player reads it, others still cannot', async () => {
    const { app, notes } = seeded();
    const response = await patch(app, GM, visibilityUrl(noteId(1)), reveal());

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      resourceClass: NOTE,
      resourceId: noteId(1),
      visibility: { mode: 'players', playerIds: [CASEY] },
      version: 2,
      changed: true,
    });
    expect(notes.rows.get(noteId(1))?.version).toBe(2);
    expect(
      (await get(app, CASEY, `/campaigns/${CAMPAIGN}/resources/${NOTE}/${noteId(1)}`)).statusCode,
    ).toBe(200);
    expect(
      (await get(app, ROWAN, `/campaigns/${CAMPAIGN}/resources/${NOTE}/${noteId(1)}`)).statusCode,
    ).toBe(404);
    await app.close();
  });

  test('duplicate reveal is a no-op: same version, changed false, one audit event', async () => {
    const { app, audit } = seeded();
    await patch(app, GM, visibilityUrl(noteId(1)), reveal());
    const again = await patch(app, GM, visibilityUrl(noteId(1)), reveal({ expectedVersion: 2 }));

    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ changed: false, version: 2 });
    expect(audit.submissions).toHaveLength(1);
    await app.close();
  });

  test('un-reveal everyone removes every audience (normalized to gm_only)', async () => {
    const { app } = seeded();
    const response = await patch(app, GM, visibilityUrl(noteId(2)), {
      operation: 'unreveal',
      target: { mode: 'everyone' },
      expectedVersion: 1,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ visibility: { mode: 'gm_only' }, version: 2 });
    await app.close();
  });

  test('stale expected version is an explicit conflict and changes nothing', async () => {
    const { app, notes } = seeded();
    const response = await patch(app, GM, visibilityUrl(noteId(1)), reveal({ expectedVersion: 7 }));

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'version_conflict' });
    expect(notes.rows.get(noteId(1))).toMatchObject({
      version: 1,
      visibility: { mode: 'gm_only' },
    });
    await app.close();
  });

  test('authorized actors get specific 400s for target problems; party is fail-closed', async () => {
    const { app } = seeded();
    const party = await patch(app, GM, visibilityUrl(noteId(1)), {
      operation: 'reveal',
      target: { mode: 'party', partyIds: [noteId(50)] },
      expectedVersion: 1,
    });
    const outsiderTarget = await patch(
      app,
      GM,
      visibilityUrl(noteId(1)),
      reveal({ target: { mode: 'players', playerIds: [OUTSIDER] } }),
    );
    const mixed = await patch(app, GM, visibilityUrl(noteId(3)), {
      operation: 'unreveal',
      target: { mode: 'party', partyIds: [noteId(50)] },
      expectedVersion: 1,
    });

    expect(party.statusCode).toBe(400);
    // Party targeting is inactive in P0: the class cannot even declare it, so it is refused before
    // any resolver question (party_unresolved is the defense in depth behind it).
    expect(party.json()).toMatchObject({ details: { reason: 'target_mode_not_allowed' } });
    expect(outsiderTarget.json()).toMatchObject({ details: { reason: 'target_not_member' } });
    expect(mixed.statusCode).toBe(400);
    await app.close();
  });

  test('schema rejects actor, role and campaign fields in the body', async () => {
    const { app, notes } = seeded();
    for (const extra of [
      { role: 'owner' },
      { actorRole: 'owner' },
      { actorUserId: GM },
      { userId: GM },
      { campaignId: CAMPAIGN },
    ]) {
      const response = await patch(app, CASEY, visibilityUrl(noteId(1)), reveal(extra));
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: 'validation_failed' });
    }
    const malformed = await patch(app, GM, visibilityUrl(noteId(1)), {
      operation: 'reveal',
      target: { mode: 'players', playerIds: [] },
      expectedVersion: 1,
    });
    expect(malformed.statusCode).toBe(400);
    expect(notes.rows.get(noteId(1))?.version).toBe(1);
    await app.close();
  });

  test('requires an authenticated session and same origin', async () => {
    const { app, notes } = seeded();
    const anonymous = await patch(app, undefined, visibilityUrl(noteId(1)), reveal());
    const crossOrigin = await patch(app, GM, visibilityUrl(noteId(1)), reveal(), {
      origin: 'https://attacker.invalid',
    });

    expect(anonymous.statusCode).toBe(401);
    expect(crossOrigin.statusCode).toBe(403);
    expect(notes.rows.get(noteId(1))?.version).toBe(1);
    await app.close();
  });
});

describe('Safe denial: hidden, missing, unknown and forbidden are indistinguishable', () => {
  test('direct requests: every denial path returns byte-identical responses', async () => {
    const { app, secrets } = seeded();
    secrets.put({ id: noteId(20), visibility: { mode: 'everyone' }, authorUserId: ROWAN });
    const responses = {
      hiddenFromPlayer: await patch(app, CASEY, visibilityUrl(noteId(1)), reveal()),
      playerCannotReveal: await patch(app, CASEY, visibilityUrl(noteId(2)), reveal()),
      missing: await patch(app, GM, visibilityUrl(MISSING), reveal()),
      unknownClass: await patch(app, GM, visibilityUrl(noteId(1), 'no_such_class'), reveal()),
      observer: await patch(app, OBSERVER, visibilityUrl(noteId(1)), reveal()),
      nonMember: await patch(app, OUTSIDER, visibilityUrl(noteId(1)), reveal()),
      otherCampaignGm: await patch(app, STRANGER, visibilityUrl(noteId(1)), reveal()),
      wrongCampaignPath: await patch(
        app,
        GM,
        visibilityUrl(noteId(1), NOTE, OTHER_CAMPAIGN),
        reveal(),
      ),
      authorPrivateOfOther: await patch(app, CASEY, visibilityUrl(noteId(20), SECRET), reveal()),
      authorPrivateGmOverride: await patch(
        app,
        GM,
        visibilityUrl(noteId(20), SECRET),
        reveal({ target: { mode: 'everyone' } }),
      ),
    };
    const reads = {
      hidden: await get(app, CASEY, `/campaigns/${CAMPAIGN}/resources/${NOTE}/${noteId(1)}`),
      missing: await get(app, CASEY, `/campaigns/${CAMPAIGN}/resources/${NOTE}/${MISSING}`),
      nonMember: await get(app, OUTSIDER, `/campaigns/${CAMPAIGN}/resources/${NOTE}/${noteId(2)}`),
      unmatchedRoute: await get(app, CASEY, '/no/such/route'),
    };

    const expected = wire(responses.missing);
    expect(responses.missing.statusCode).toBe(404);
    expect(JSON.parse(responses.missing.body)).toEqual({
      code: 'not_found_or_forbidden',
      message: 'Not found.',
    });
    for (const [name, response] of Object.entries({ ...responses, ...reads })) {
      expect([name, wire(response)]).toEqual([name, expected]);
    }
  });

  test('a denied request changes nothing and writes no audit event', async () => {
    const { app, notes, audit } = seeded();
    await patch(app, CASEY, visibilityUrl(noteId(1)), reveal());
    await patch(app, OBSERVER, visibilityUrl(noteId(1)), reveal());

    expect(notes.rows.get(noteId(1))).toMatchObject({
      version: 1,
      visibility: { mode: 'gm_only' },
    });
    expect(notes.writes).toBe(0);
    expect(audit.submissions).toHaveLength(0);
    await app.close();
  });

  test('denial metrics carry class and reason only, never an actor', async () => {
    const { app, denials } = seeded();
    await patch(app, CASEY, visibilityUrl(noteId(1)), reveal());
    await patch(app, GM, visibilityUrl(MISSING), reveal());
    await patch(app, OUTSIDER, visibilityUrl(noteId(1)), reveal());

    expect(denials).toContainEqual([NOTE, 'visibility_denied']);
    expect(denials).toContainEqual([NOTE, 'not_found']);
    expect(denials).toContainEqual([NOTE, 'actor_not_member']);
    const serialized = JSON.stringify(denials);
    for (const userId of [GM, CASEY, OUTSIDER]) expect(serialized).not.toContain(userId);
    await app.close();
  });
});

describe('Client role spoofing never reaches a Decision', () => {
  test('headers, query and cookies naming a role are ignored on reveal and read', async () => {
    const { app, notes } = seeded();
    const forged = {
      'x-role': 'owner',
      'x-campaign-role': 'gm',
      role: 'owner',
      'x-actor-role': 'gm',
    };
    const reveals = [
      await patch(
        app,
        CASEY,
        `${visibilityUrl(noteId(1))}?role=owner&actorRole=gm`,
        reveal(),
        forged,
      ),
      await patch(app, ROWAN, visibilityUrl(noteId(1)), reveal(), {
        ...forged,
        cookie: `${sessionCookie(ROWAN)}; role=owner`,
      }),
    ];
    const read = await app.inject({
      method: 'GET',
      url: `/campaigns/${CAMPAIGN}/resources/${NOTE}/${noteId(1)}?role=gm`,
      headers: { cookie: sessionCookie(CASEY), ...forged },
    });

    for (const response of [...reveals, read]) {
      expect(response.statusCode).toBe(404);
      expect(JSON.parse(response.body)).toEqual({
        code: 'not_found_or_forbidden',
        message: 'Not found.',
      });
    }
    expect(notes.rows.get(noteId(1))).toMatchObject({
      version: 1,
      visibility: { mode: 'gm_only' },
    });
    await app.close();
  });

  test('a spoofed header cannot downgrade a real GM either: the resolved role decides', async () => {
    const { app } = seeded();
    const response = await patch(app, GM, visibilityUrl(noteId(1)), reveal(), {
      'x-role': 'player',
    });

    expect(response.statusCode).toBe(200);
    await app.close();
  });
});

describe('Repeat enforcement at the application mutation boundary', () => {
  test('VisibilityService rechecks even when a route skips the pre-handler', async () => {
    const context = fixtureContext();
    const { app, notes, visibility } = fixtureApp(context);
    notes.put({ id: noteId(1), visibility: { mode: 'gm_only' } });
    // Deliberately outside the content namespace and without the sanctioned helper.
    app.patch('/unguarded/:resourceId', async (request, reply) => {
      const user = request.authenticatedUser;
      if (user === undefined) return sendSafeDenial(reply);
      const result = await visibility.change(user.userId, {
        campaignId: CAMPAIGN,
        resourceClass: NOTE,
        resourceId: (request.params as { resourceId: string }).resourceId,
        operation: 'reveal',
        target: { mode: 'everyone' },
        expectedVersion: 1,
      });
      return reply.status(result.status === 'changed' ? 200 : 404).send({ status: result.status });
    });

    const denied = await patch(app, CASEY, `/unguarded/${noteId(1)}`, {});
    const allowed = await patch(app, GM, `/unguarded/${noteId(1)}`, {});

    expect(denied.statusCode).toBe(404);
    expect(allowed.statusCode).toBe(200);
    expect(notes.rows.get(noteId(1))).toMatchObject({
      visibility: { mode: 'everyone' },
      version: 2,
    });
    expect(notes.writes).toBe(1);
    await app.close();
  });

  test('a membership revoked between the pre-handler and the service is denied safely', async () => {
    const context = fixtureContext();
    const { app, notes, members } = fixtureApp(context);
    notes.put({ id: noteId(1), visibility: { mode: 'gm_only' } });
    // Pre-handler resolves the actor once; the service's own resolve then finds no membership.
    members.revokeAfter(1);
    const response = await patch(app, GM, visibilityUrl(noteId(1)), reveal());

    expect(response.statusCode).toBe(404);
    expect(JSON.parse(response.body)).toEqual({
      code: 'not_found_or_forbidden',
      message: 'Not found.',
    });
    expect(notes.writes).toBe(0);
    await app.close();
  });
});

describe('Lists and counts are filtered before serialization', () => {
  const list = (app: FastifyInstance, userId: string, query = '', resourceClass = NOTE) =>
    get(app, userId, `/campaigns/${CAMPAIGN}/resources/${resourceClass}${query}`);

  test('each role sees only the permitted set; totals come from that set', async () => {
    const { app } = seeded();
    const gm = (await list(app, GM)).json();
    const casey = (await list(app, CASEY)).json();
    const rowan = (await list(app, ROWAN)).json();
    const observer = (await list(app, OBSERVER)).json();

    expect(gm.total).toBe(5);
    expect(casey.items.map((item: { id: string }) => item.id)).toEqual([noteId(2), noteId(3)]);
    expect(casey.total).toBe(2);
    expect(rowan.items.map((item: { id: string }) => item.id)).toEqual([noteId(2), noteId(5)]);
    expect(observer).toEqual({ items: [], total: 0 });
    await app.close();
  });

  test('pagination is over the permitted set, so hidden rows leave no gap or count', async () => {
    const { app } = seeded();
    const first = (await list(app, CASEY, '?limit=1&offset=0')).json();
    const second = (await list(app, CASEY, '?limit=1&offset=1')).json();
    const beyond = (await list(app, CASEY, '?limit=1&offset=2')).json();

    expect(first.items.map((item: { id: string }) => item.id)).toEqual([noteId(2)]);
    expect(second.items.map((item: { id: string }) => item.id)).toEqual([noteId(3)]);
    expect([first.total, second.total, beyond.total]).toEqual([2, 2, 2]);
    expect(beyond.items).toEqual([]);
    await app.close();
  });

  test('hidden rows are indistinguishable: removing them leaves identical bytes', async () => {
    const withHidden = seeded();
    const withoutHidden = fixtureApp();
    registerFixtureContentRoutes(withoutHidden.app, withoutHidden);
    withoutHidden.notes.put({
      id: noteId(2),
      visibility: { mode: 'everyone' },
      title: `title-${noteId(2).slice(-4)}`,
    });
    withoutHidden.notes.put({ id: noteId(3), visibility: { mode: 'players', playerIds: [CASEY] } });

    for (const query of ['', '?limit=1', '?limit=1&offset=1', '?offset=9']) {
      const left = await list(withHidden.app, CASEY, query);
      const right = await list(withoutHidden.app, CASEY, query);
      expect([query, wire(left)]).toEqual([query, wire(right)]);
    }
    await withHidden.app.close();
    await withoutHidden.app.close();
  });

  test('non-member and unknown campaign lists use the safe denial', async () => {
    const { app } = seeded();
    const nonMember = await list(app, OUTSIDER);
    const stranger = await list(app, STRANGER);
    const unauthenticated = await get(app, undefined, `/campaigns/${CAMPAIGN}/resources/${NOTE}`);

    expect(wire(nonMember)).toBe(wire(stranger));
    expect(nonMember.statusCode).toBe(404);
    expect(unauthenticated.statusCode).toBe(401);
    await app.close();
  });

  test('author-private lists hold even a GM role to the Ownership Rule', async () => {
    const { app, secrets } = seeded();
    secrets.put({ id: noteId(30), visibility: { mode: 'everyone' }, authorUserId: CASEY });
    secrets.put({ id: noteId(31), visibility: { mode: 'everyone' }, authorUserId: ROWAN });
    const gm = (await list(app, GM, '', SECRET)).json();
    const casey = (await list(app, CASEY, '', SECRET)).json();

    expect(gm).toEqual({ items: [], total: 0 });
    expect(casey.items.map((item: { id: string }) => item.id)).toEqual([noteId(30)]);
    expect(casey.total).toBe(1);
    await app.close();
  });

  test('a collection handler that skips the filter cannot send rows (tripwire)', async () => {
    const fixture = fixtureApp();
    registerFixtureContentRoutes(fixture.app, fixture, { unfiltered: true });
    fixture.notes.put({ id: noteId(1), visibility: { mode: 'gm_only' } });
    const response = await list(fixture.app, CASEY);

    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain(noteId(1));
    expect(response.json()).toMatchObject({ code: 'internal_error' });
    await fixture.app.close();
  });
});

describe('Content route inventory', () => {
  test('lists every sanctioned content route and accepts a complete app', async () => {
    const fixture = seeded();
    await fixture.app.ready();
    const guarded = fixture.access.inventory
      .guarded()
      .map(
        (entry) =>
          `${entry.method} ${entry.url} ${entry.sanctioned?.kind}:${entry.sanctioned?.capability}`,
      );

    expect(guarded).toContain(
      'PATCH /campaigns/:campaignId/resources/:class/:resourceId/visibility resource:reveal',
    );
    expect(guarded).toContain(`GET /campaigns/:campaignId/resources/${NOTE} collection:read`);
    expect(guarded).toContain(
      `GET /campaigns/:campaignId/resources/${NOTE}/:resourceId resource:read`,
    );
    expect(fixture.access.inventory.violations()).toEqual([]);
    await fixture.app.close();
  });

  test('a content route without the sanctioned helper makes the app fail to start', async () => {
    const fixture = fixtureApp();
    fixture.app.get('/campaigns/:campaignId/resources/leaky/:resourceId', async () => ({
      leak: true,
    }));

    let failure: unknown;
    try {
      await fixture.app.ready();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(UnsanctionedContentRouteError);
    expect(
      fixture.access.inventory
        .violations()
        .map((violation) => `${violation.method} ${violation.url}`),
    ).toContain('GET /campaigns/:campaignId/resources/leaky/:resourceId');
    expect(fixture.access.inventory.violations()[0]?.reason).toBe(
      'content_route_without_sanctioned_helper',
    );
    await fixture.app.close().catch(() => undefined);
  });

  test('config.contentRoute opts a route outside the prefix into the requirement', async () => {
    const fixture = fixtureApp();
    fixture.app.get('/exports/:campaignId', { config: { contentRoute: true } }, async () => ({
      rows: [],
    }));
    fixture.app.get('/health-like', async () => ({ ok: true }));

    expect(
      new Set(fixture.access.inventory.violations().map((violation) => violation.url)),
    ).toEqual(new Set(['/exports/:campaignId']));
    const unclassified = fixture.access.inventory
      .routes()
      .find((entry) => entry.url === '/health-like');
    expect(unclassified?.content).toBe(false);
    await fixture.app.close().catch(() => undefined);
  });

  test('a lookalike function cannot stand in for the sanctioned helper', async () => {
    const fixture = fixtureApp();
    fixture.app.get(
      '/campaigns/:campaignId/resources/fake/:resourceId',
      { preHandler: async () => undefined },
      async () => ({ leak: true }),
    );

    expect(fixture.access.inventory.violations().length).toBeGreaterThan(0);
    await fixture.app.close().catch(() => undefined);
  });
});

describe('Attachment-owner delegation (decision helper, no signed URL without allow)', () => {
  /** Stands in for feature 05: it holds a parent reference and never decides on its own. */
  function attachmentOwner(fixture: ReturnType<typeof seeded>) {
    const attachments = new Map([
      ['att-visible', { campaignId: CAMPAIGN, parentClass: NOTE, parentId: noteId(2) }],
      ['att-hidden', { campaignId: CAMPAIGN, parentClass: NOTE, parentId: noteId(1) }],
      ['att-orphan', { campaignId: CAMPAIGN, parentClass: NOTE, parentId: MISSING }],
      ['att-class', { campaignId: CAMPAIGN, parentClass: 'no_such_class', parentId: noteId(2) }],
    ]);
    const issued: string[] = [];
    return {
      issued,
      async signedUrl(userId: string, attachmentId: string): Promise<string | undefined> {
        const attachment = attachments.get(attachmentId);
        if (attachment === undefined) return undefined;
        const outcome = await fixture.access.authorizeResource(userId, {
          campaignId: attachment.campaignId,
          resourceClass: attachment.parentClass,
          resourceId: attachment.parentId,
          capability: 'read',
        });
        if (!outcome.allowed) return undefined;
        issued.push(attachmentId);
        return `https://objects.invalid/${attachmentId}?sig=fixture`;
      },
    };
  }

  test('the parent record decides: allowed, hidden, missing, unknown class and non-member', async () => {
    const fixture = seeded();
    const owner = attachmentOwner(fixture);

    expect(await owner.signedUrl(CASEY, 'att-visible')).toContain('att-visible');
    expect(await owner.signedUrl(GM, 'att-hidden')).toContain('att-hidden');
    expect(await owner.signedUrl(CASEY, 'att-hidden')).toBeUndefined();
    expect(await owner.signedUrl(OBSERVER, 'att-visible')).toBeUndefined();
    expect(await owner.signedUrl(OUTSIDER, 'att-visible')).toBeUndefined();
    expect(await owner.signedUrl(GM, 'att-orphan')).toBeUndefined();
    expect(await owner.signedUrl(GM, 'att-class')).toBeUndefined();
    expect(owner.issued).toEqual(['att-visible', 'att-hidden']);
    await fixture.app.close();
  });

  test('narrowing the parent revokes the next signed URL', async () => {
    const fixture = seeded();
    const owner = attachmentOwner(fixture);
    expect(await owner.signedUrl(ROWAN, 'att-visible')).toBeDefined();

    await patch(fixture.app, GM, visibilityUrl(noteId(2)), {
      operation: 'unreveal',
      target: { mode: 'everyone' },
      expectedVersion: 1,
    });

    expect(await owner.signedUrl(ROWAN, 'att-visible')).toBeUndefined();
    expect(await owner.signedUrl(GM, 'att-visible')).toBeDefined();
    await fixture.app.close();
  });

  test('a class with no facts source denies instead of guessing', async () => {
    const fixture = seeded();
    const outcome = await fixture.access.authorizeResource(GM, {
      campaignId: CAMPAIGN,
      resourceClass: NOTE,
      resourceId: noteId(2),
      capability: 'delete',
    });
    expect(outcome).toEqual({ allowed: false, reason: 'unknown_capability' });
    await fixture.app.close();
  });
});

describe('Fixture adapter conformance', () => {
  test('the in-memory owner adapter passes the shared adapter contract kit', async () => {
    const { notes } = fixtureContext();
    const report = await runVisibilityAdapterContract({
      adapter: notes,
      seed: async ({ campaignId, visibility }) => {
        const id = crypto.randomUUID();
        notes.put({ id, campaignId, visibility });
        return id;
      },
      tombstone: async (_campaignId, resourceId) => {
        const row = notes.rows.get(resourceId);
        if (row !== undefined) row.deleted = true;
      },
    });
    expect(report.findings).toEqual([]);
    expect(report.checks).toContain('concurrent_single_winner');
  });
});
