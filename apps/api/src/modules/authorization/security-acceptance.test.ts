import { describe, expect, test } from 'bun:test';
import {
  checkAuthorPrivate,
  evaluateSyncRule,
  findSyncDivergences,
  type ResourceFacts,
  ResourcePolicyRegistry,
  requesterFromActor,
  runPolicyConformance,
  SyncPredicateCompiler,
  syncTruthTable,
  truthRequester,
} from '@rpg/authorization';
import type { Visibility } from '@rpg/contracts';
import { REGISTERED_RESOURCE_POLICIES } from '../sync/sync-rules.ts';
import { ContentAccess } from './content-access.ts';
import { DenialTelemetry } from './denial-telemetry.ts';
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
  OUTSIDER,
  ROWAN,
  registerFixtureContentRoutes,
  SECRET,
  sessionCookie,
} from './test-fixture.ts';

/**
 * Feature 04 task 07: security acceptance across what exists. No production content class,
 * attachment store, export or PowerSync service exists yet; each section states the level proved.
 */

function seeded() {
  const fixture = fixtureApp();
  registerFixtureContentRoutes(fixture.app, fixture);
  fixture.notes.put({ id: noteId(1), visibility: { mode: 'gm_only' } });
  return fixture;
}

const visibilityUrl = `/campaigns/${CAMPAIGN}/resources/${NOTE}/${noteId(1)}/visibility`;
const readUrl = `/campaigns/${CAMPAIGN}/resources/${NOTE}/${noteId(1)}`;
const listUrl = `/campaigns/${CAMPAIGN}/resources/${NOTE}`;

function change(
  app: ReturnType<typeof seeded>['app'],
  userId: string | undefined,
  payload: unknown,
) {
  return app.inject({
    method: 'PATCH',
    url: visibilityUrl,
    headers: {
      origin: ORIGIN,
      ...(userId === undefined ? {} : { cookie: sessionCookie(userId) }),
    },
    payload: payload as object,
  });
}

function read(app: ReturnType<typeof seeded>['app'], userId: string, url = readUrl) {
  return app.inject({ method: 'GET', url, headers: { cookie: sessionCookie(userId) } });
}

/* --------------------------------------------------------------------------------------------
 * Every content class passes the shared matrix before route registration.
 * ------------------------------------------------------------------------------------------ */

describe('Every content class passes the shared matrix before route registration', () => {
  const context = fixtureContext();
  const production = new ResourcePolicyRegistry();
  for (const policy of REGISTERED_RESOURCE_POLICIES) production.register(policy);
  const registries: { readonly name: string; readonly registry: ResourcePolicyRegistry }[] = [
    { name: 'registered production policies', registry: production },
    { name: 'fixture classes', registry: context.registry },
  ];

  for (const { name, registry } of registries) {
    for (const policy of registry.policies()) {
      test(`${name}: ${policy.resourceClass} has no conformance finding and no sync divergence`, () => {
        const report = runPolicyConformance(registry, policy.resourceClass);
        expect(report.findings).toEqual([]);
        expect(report.cases).toBeGreaterThan(0);

        const table = syncTruthTable(registry, policy.resourceClass);
        expect(table.cases.length).toBeGreaterThan(0);
        if (policy.sync.kind === 'server_only') {
          // Server-only classes never replicate: the API may read them, a replica never holds one.
          expect(table.cases.filter((item) => item.synced)).toEqual([]);
        } else {
          expect(findSyncDivergences(table)).toEqual([]);
        }
        // No exempt role makes a class author-private; with GM roles exempt (characters) the Ownership Rule
        // above is the whole check.
        if (policy.ownership !== undefined && policy.ownership.exemptRoles.length === 0) {
          expect(checkAuthorPrivate(registry, policy.resourceClass).findings).toEqual([]);
        }
      });
    }
  }

  test('the sets are non-empty, so the conformance loops cannot pass vacuously', () => {
    expect(REGISTERED_RESOURCE_POLICIES.length).toBeGreaterThan(0);
    expect(context.registry.policies().length).toBe(2);
  });

  test('an observed sync that disagrees with the API is detected (mutation sensitivity)', () => {
    const table = syncTruthTable(context.registry, NOTE);
    expect(findSyncDivergences(table, () => true).length).toBeGreaterThan(0);
    expect(findSyncDivergences(table, () => false).length).toBeGreaterThan(0);
  });

  test('an unguarded content route cannot start the application (runtime inventory)', async () => {
    const fixture = fixtureApp();
    fixture.app.get('/campaigns/:campaignId/resources/rogue', async () => ({ items: [] }));
    let message = '';
    try {
      await fixture.app.ready();
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('unsanctioned_content_routes');
    await fixture.app.close();
  });
});

/* --------------------------------------------------------------------------------------------
 * Local replicas. Simulated replica = rows whose compiled sync predicate matches the requester.
 * PowerSync is not running; the provider round trip is unverified.
 * ------------------------------------------------------------------------------------------ */

describe('Local replicas hold zero unauthorized GM-only or private rows', () => {
  for (const resourceClass of [NOTE, SECRET]) {
    test(`${resourceClass}: no player requester receives a GM-only, other-campaign, observer or foreign-private row (live or tombstone)`, () => {
      const { registry } = fixtureContext();
      const table = syncTruthTable(registry, resourceClass);
      let playerDeliveries = 0;
      for (const item of table.cases) {
        if (!item.synced) continue;
        const { requester, row } = item;
        const role = requester.memberships.find(
          (membership) => membership.campaignId === row.facts.campaignId && !membership.removed,
        )?.role;
        expect(role).toBeDefined();
        expect(role).not.toBe('observer');
        expect(item.api).toBe(true);
        if (role === 'player') {
          playerDeliveries += 1;
          expect(row.facts.visibility.mode).not.toBe('gm_only');
          if (row.facts.visibility.mode === 'players') {
            expect(row.facts.visibility.playerIds).toContain(requester.userId);
          }
          if (resourceClass === SECRET) expect(row.facts.authorUserId).toBe(requester.userId);
        }
      }
      expect(playerDeliveries).toBeGreaterThan(0);
    });
  }

  test('author-private rows never reach a GM role replica', () => {
    const { registry } = fixtureContext();
    const table = syncTruthTable(registry, SECRET);
    const gm = table.requesters.find((item) => item.label === 'gm');
    const delivered = table.cases.filter(
      (item) => item.requester.label === 'gm' && item.synced && item.row.facts.authorUserId,
    );
    expect(gm).toBeDefined();
    expect(delivered.filter((item) => item.row.facts.authorUserId !== gm?.userId)).toEqual([]);
  });

  test('reveal delivers to the recipient only; un-reveal removes local access after the next sync', async () => {
    const { app, notes, registry } = seeded();
    const rule = new SyncPredicateCompiler(registry).compile(NOTE, 'read').rule;
    const replica = (userId: string, role: 'player' | 'gm') => {
      const requester = requesterFromActor({ userId, campaignId: CAMPAIGN, role });
      return [...notes.rows.values()]
        .map((row) => notes.factsOf(row))
        .filter((facts) => evaluateSyncRule(rule, requester, facts))
        .map((facts) => facts.resourceId);
    };

    expect(replica(CASEY, 'player')).toEqual([]);
    expect(replica(ROWAN, 'player')).toEqual([]);

    const revealed = await change(app, GM, {
      operation: 'reveal',
      target: { mode: 'players', playerIds: [CASEY] },
      expectedVersion: 1,
    });
    expect(revealed.statusCode).toBe(200);
    expect(replica(CASEY, 'player')).toEqual([noteId(1)]);
    expect(replica(ROWAN, 'player')).toEqual([]);

    const removed = await change(app, GM, {
      operation: 'unreveal',
      target: { mode: 'players', playerIds: [CASEY] },
      expectedVersion: 2,
    });
    expect(removed.statusCode).toBe(200);
    // The next sync no longer matches, so the provider emits a REMOVE for Casey's bucket.
    expect(replica(CASEY, 'player')).toEqual([]);
    expect(replica(GM, 'gm')).toEqual([noteId(1)]);
    await app.close();
  });

  test('hidden rows add no row, count or tombstone to a player replica', () => {
    const { registry } = fixtureContext();
    const rule = new SyncPredicateCompiler(registry).compile(NOTE, 'read').rule;
    const rowan = requesterFromActor({ userId: ROWAN, campaignId: CAMPAIGN, role: 'player' });
    const hidden = (index: number): ResourceFacts => ({
      campaignId: CAMPAIGN,
      resourceClass: NOTE,
      resourceId: noteId(index),
      visibility: { mode: 'gm_only' } as Visibility,
      version: 1,
    });
    const rows = [...Array(25).keys()].map((index) => hidden(index + 1));
    // A tombstone is the same row with a bumped version and a deleted marker; the predicate sees
    // only visibility and campaign, so it is as hidden as the live row.
    const tombstones = rows.map((row) => ({ ...row, version: 3 }));
    expect([...rows, ...tombstones].filter((row) => evaluateSyncRule(rule, rowan, row))).toEqual(
      [],
    );
  });

  test('removed members, non-members, other-campaign members and observers never sync', () => {
    const { registry } = fixtureContext();
    const table = syncTruthTable(registry, NOTE);
    for (const label of ['removed_gm', 'non_member', 'other_campaign_gm', 'observer']) {
      const requester = table.requesters.find((item) => item.label === label);
      expect(requester).toBeDefined();
      if (requester === undefined) continue;
      const here = truthRequester(requester).roleIn(table.campaignId);
      expect(here === undefined || here === 'observer').toBe(true);
      // Rows of the requester's own campaign only; none of this campaign's rows.
      const leaked = table.cases.filter(
        (item) =>
          item.requester.label === label &&
          item.synced &&
          item.row.facts.campaignId === table.campaignId,
      );
      expect(leaked).toEqual([]);
    }
  });
});

/* --------------------------------------------------------------------------------------------
 * Audit: only accepted visibility mutations are audited; denials are not.
 * ------------------------------------------------------------------------------------------ */

describe('Audit records accepted visibility mutations only', () => {
  test('accepted reveal and un-reveal are audited; denials, conflicts, no-ops and bad targets are not', async () => {
    const { app, audit } = seeded();

    for (const actor of [CASEY, OBSERVER, OUTSIDER, undefined]) {
      await change(app, actor, {
        operation: 'reveal',
        target: { mode: 'everyone' },
        expectedVersion: 1,
      });
    }
    expect(audit.submissions).toHaveLength(0);

    const bad = await change(app, GM, {
      operation: 'reveal',
      target: { mode: 'players', playerIds: [OUTSIDER] },
      expectedVersion: 1,
    });
    expect(bad.statusCode).toBe(400);
    expect(audit.submissions).toHaveLength(0);

    const reveal = { operation: 'reveal', target: { mode: 'players', playerIds: [CASEY] } };
    expect((await change(app, GM, { ...reveal, expectedVersion: 1 })).statusCode).toBe(200);
    expect(audit.submissions).toHaveLength(1);

    const duplicate = await change(app, GM, { ...reveal, expectedVersion: 2 });
    expect(duplicate.json().changed).toBe(false);
    expect((await change(app, GM, { ...reveal, expectedVersion: 1 })).statusCode).toBe(409);
    expect(audit.submissions).toHaveLength(1);

    const removed = await change(app, GM, {
      operation: 'unreveal',
      target: { mode: 'players', playerIds: [CASEY] },
      expectedVersion: 2,
    });
    expect(removed.statusCode).toBe(200);
    expect(audit.submissions.map((item) => item.event.action)).toEqual([
      'visibility.revealed',
      'visibility.unrevealed',
    ]);
    await app.close();
  });

  test('safe denial on reads writes no audit event', async () => {
    const { app, audit } = seeded();
    for (const actor of [CASEY, ROWAN, OUTSIDER]) {
      expect((await read(app, actor)).statusCode).toBe(404);
    }
    expect(audit.submissions).toHaveLength(0);
    await app.close();
  });
});

/* --------------------------------------------------------------------------------------------
 * Attachment delegation. No attachment store exists; the sanctioned helper any attachment owner
 * must call (`authorizeResource`) is tested as a signed-URL gate.
 * ------------------------------------------------------------------------------------------ */

describe('Attachment delegation: no signed URL without an allow on the parent', () => {
  const sign = async (
    context: ReturnType<typeof fixtureContext>,
    userId: string,
    resourceClass: string,
    resourceId: string,
  ) => {
    const outcome = await context.access.authorizeResource(userId, {
      campaignId: CAMPAIGN,
      resourceClass,
      resourceId,
      capability: 'read',
    });
    return outcome.allowed ? `https://files.invalid/signed/${resourceId}` : undefined;
  };

  test('signs for the revealed player only, and stops when the parent is un-revealed', async () => {
    const context = fixtureContext();
    context.notes.put({ id: noteId(1), visibility: { mode: 'gm_only' } });
    expect(await sign(context, CASEY, NOTE, noteId(1))).toBeUndefined();
    expect(await sign(context, GM, NOTE, noteId(1))).toBeDefined();

    const revealed = await context.visibility.change(GM, {
      campaignId: CAMPAIGN,
      resourceClass: NOTE,
      resourceId: noteId(1),
      operation: 'reveal',
      target: { mode: 'players', playerIds: [CASEY] },
      expectedVersion: 1,
    });
    expect(revealed.status).toBe('changed');
    expect(await sign(context, CASEY, NOTE, noteId(1))).toBeDefined();
    for (const denied of [ROWAN, OBSERVER, OUTSIDER]) {
      expect(await sign(context, denied, NOTE, noteId(1))).toBeUndefined();
    }

    await context.visibility.change(GM, {
      campaignId: CAMPAIGN,
      resourceClass: NOTE,
      resourceId: noteId(1),
      operation: 'unreveal',
      target: { mode: 'players', playerIds: [CASEY] },
      expectedVersion: 2,
    });
    expect(await sign(context, CASEY, NOTE, noteId(1))).toBeUndefined();
  });

  test('author-private parent: no URL for a GM role; unknown class and missing parent deny', async () => {
    const context = fixtureContext();
    context.secrets.put({
      id: noteId(2),
      visibility: { mode: 'players', playerIds: [CASEY] },
      authorUserId: CASEY,
    });
    expect(await sign(context, CASEY, SECRET, noteId(2))).toBeDefined();
    expect(await sign(context, GM, SECRET, noteId(2))).toBeUndefined();
    expect(await sign(context, CASEY, 'nonexistent', noteId(2))).toBeUndefined();
    expect(await sign(context, CASEY, SECRET, noteId(404))).toBeUndefined();
  });
});

/* --------------------------------------------------------------------------------------------
 * Export: feature 07 has no implementation. An export must reuse the same read decision, which
 * the shared-matrix section above proves for API and sync. No export test is invented here.
 * ------------------------------------------------------------------------------------------ */

/* --------------------------------------------------------------------------------------------
 * Denial telemetry: class and reason only.
 * ------------------------------------------------------------------------------------------ */

describe('Denial telemetry aggregates by resource class and reason, never by actor', () => {
  test('counts per class and reason', () => {
    const telemetry = new DenialTelemetry();
    telemetry.record(NOTE, 'visibility_denied');
    telemetry.record(NOTE, 'visibility_denied');
    telemetry.record(SECRET, 'ownership_denied');
    expect(telemetry.snapshot()).toEqual([
      { resourceClass: NOTE, reason: 'visibility_denied', count: 2 },
      { resourceClass: SECRET, reason: 'ownership_denied', count: 1 },
    ]);
    expect(telemetry.total()).toBe(3);
    telemetry.reset();
    expect(telemetry.snapshot()).toEqual([]);
  });

  test('bounds distinct class labels', () => {
    const telemetry = new DenialTelemetry();
    for (let index = 0; index < 1000; index += 1) telemetry.record(`class_${index}`, 'not_found');
    const classes = new Set(telemetry.snapshot().map((item) => item.resourceClass));
    expect(classes.size).toBeLessThanOrEqual(257);
    expect(telemetry.total()).toBe(1000);
  });

  test('reports and clears totals per interval, skips empty intervals, and flushes on stop', async () => {
    const telemetry = new DenialTelemetry();
    const reports: unknown[] = [];
    const stop = telemetry.startReporting((denials) => reports.push(denials), 20);
    telemetry.record(NOTE, 'visibility_denied');
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(reports).toEqual([[{ resourceClass: NOTE, reason: 'visibility_denied', count: 1 }]]);
    expect(telemetry.snapshot()).toEqual([]);
    telemetry.record(SECRET, 'ownership_denied');
    stop();
    expect(reports).toHaveLength(2);
    expect(reports[1]).toEqual([{ resourceClass: SECRET, reason: 'ownership_denied', count: 1 }]);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(reports).toHaveLength(2);
  });

  test('wired through ContentAccess over HTTP: the aggregate holds no actor, campaign or record id', async () => {
    const telemetry = new DenialTelemetry();
    const base = fixtureContext();
    const access = new ContentAccess({
      registry: base.registry,
      actors: base.members,
      onDenied: telemetry.record,
    });
    const fixture = fixtureApp({ ...base, access });
    registerFixtureContentRoutes(fixture.app, fixture);
    fixture.notes.put({ id: noteId(1), visibility: { mode: 'gm_only' } });

    for (const actor of [CASEY, ROWAN, OUTSIDER, OBSERVER]) {
      await read(fixture.app, actor);
    }
    await read(fixture.app, OUTSIDER, listUrl);

    const snapshot = telemetry.snapshot();
    expect(telemetry.total()).toBeGreaterThanOrEqual(4);
    for (const item of snapshot) {
      expect(Object.keys(item).sort()).toEqual(['count', 'reason', 'resourceClass']);
    }
    const serialized = JSON.stringify(snapshot);
    for (const id of [CASEY, ROWAN, OUTSIDER, OBSERVER, GM, CAMPAIGN, noteId(1)]) {
      expect(serialized).not.toContain(id);
    }
    await fixture.app.close();
  });
});
