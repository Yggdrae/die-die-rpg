import { describe, expect, test } from 'bun:test';
import {
  AuthorityMutationService,
  InMemoryLongTextHoldRepository,
  InMemoryMutationReceiptStore,
  LongTextHoldService,
  MutationApplierRegistry,
  SyncBootstrapService,
} from '@rpg/sync';
import { buildApp } from '../../app.ts';
import { registerIdentityAuthentication } from '../identity/authenticate.ts';
import { registerSyncRoutes } from './routes.ts';

const ORIGIN = 'http://localhost:5173';
const CREDENTIAL = 'a'.repeat(43);
const USER = '00000000-0000-4000-8000-000000000001';
const SESSION = '00000000-0000-4000-8000-000000000002';
const CAMPAIGN = '00000000-0000-4000-8000-000000000003';
const REPLICA = '00000000-0000-4000-8000-000000000004';
const HELD_EVENT = '00000000-0000-4000-8000-0000000000e1';

function setup() {
  let active = true;
  const app = buildApp();
  registerIdentityAuthentication(app, {
    authenticate: async (credential) =>
      credential === CREDENTIAL ? { userId: USER, sessionId: SESSION } : undefined,
  });
  const access = {
    resolve: async (userId: string, campaignId: string) =>
      active && userId === USER && campaignId === CAMPAIGN
        ? { userId, campaignId, role: 'gm' as const }
        : undefined,
  };
  const registry = new MutationApplierRegistry();
  const sessions: (string | undefined)[] = [];
  registry.register({
    featureId: 'entities',
    tableName: 'entities',
    apply: async ({ mutation, sessionId }) => {
      sessions.push(sessionId);
      return {
        status: 'accepted',
        version: (mutation.expectedVersion ?? 0) + 1,
        cursor: `cursor-${mutation.causalSequence}`,
      };
    },
  });
  const watermarks: unknown[] = [];
  const subscriptions: unknown[] = [];
  const decisions: unknown[] = [];
  const hiddenRecords = new Set<string>();
  const auditResolutions: unknown[] = [];
  const records = {
    authorizeResource: async (
      userId: string,
      input: {
        readonly campaignId: string;
        readonly resourceClass: string;
        readonly resourceId: string;
        readonly capability: string;
      },
    ) => {
      decisions.push({ userId, ...input });
      return active &&
        userId === USER &&
        input.campaignId === CAMPAIGN &&
        !hiddenRecords.has(input.resourceId)
        ? {
            allowed: true as const,
            actor: { userId, campaignId: CAMPAIGN, role: 'gm' as const },
            facts: {
              campaignId: CAMPAIGN,
              resourceClass: input.resourceClass,
              resourceId: input.resourceId,
              visibility: { mode: 'everyone' as const },
              version: 1,
            },
          }
        : { allowed: false as const, reason: 'not_found' as const };
    },
  };
  registerSyncRoutes(
    app,
    {
      access,
      bootstrap: new SyncBootstrapService(
        access,
        'http://localhost:8080',
        { issue: async () => 'signed-token' },
        undefined,
        undefined,
        { register: async (input) => void subscriptions.push(input) },
      ),
      mutations: new AuthorityMutationService(access, registry, new InMemoryMutationReceiptStore()),
      holds: new LongTextHoldService(new InMemoryLongTextHoldRepository()),
      records,
      watermarks: {
        acknowledge: async (input) => void watermarks.push(input),
        replicaDropped: async (input) => void watermarks.push(input),
      },
      // Only HELD_EVENT in the campaign store resolves (stands in for the feature 04 decision).
      auditAcknowledgements: {
        resolve: async (actor, tableName, eventId) => {
          auditResolutions.push({ actor, tableName, eventId });
          return tableName === 'audit_campaign_events' && eventId === HELD_EVENT ? 42 : undefined;
        },
      },
    },
    { allowedOrigin: ORIGIN },
  );
  return {
    app,
    sessions,
    revoke: () => {
      active = false;
    },
    watermarks,
    subscriptions,
    decisions,
    auditResolutions,
    hide: (recordId: string) => void hiddenRecords.add(recordId),
  };
}

const authenticatedHeaders = {
  cookie: `rpg_session=${CREDENTIAL}`,
  origin: ORIGIN,
};

describe('sync routes', () => {
  test('bootstrap with a stable replica id registers that subscriber only after access', async () => {
    const { app, revoke, subscriptions } = setup();
    const response = await app.inject({
      method: 'GET',
      url: `/sync/bootstrap/${CAMPAIGN}?replicaId=${REPLICA}`,
      headers: { cookie: `rpg_session=${CREDENTIAL}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().replicaId).toBe(REPLICA);
    expect(subscriptions).toEqual([
      { campaignId: CAMPAIGN, userId: USER, replicaId: REPLICA, subscribedAt: expect.any(Date) },
    ]);
    const invalid = await app.inject({
      method: 'GET',
      url: `/sync/bootstrap/${CAMPAIGN}?replicaId=not-a-uuid`,
      headers: { cookie: `rpg_session=${CREDENTIAL}` },
    });
    expect(invalid.statusCode).toBe(400);
    revoke();
    const denied = await app.inject({
      method: 'GET',
      url: `/sync/bootstrap/${CAMPAIGN}?replicaId=${REPLICA}`,
      headers: { cookie: `rpg_session=${CREDENTIAL}` },
    });
    expect(denied.statusCode).toBe(404);
    expect(subscriptions).toHaveLength(1);
    await app.close();
  });

  test('acknowledgement forwards pending record ids and is denied after revocation', async () => {
    const { app, revoke, watermarks } = setup();
    const record = '00000000-0000-4000-8000-000000000009';
    const ack = await app.inject({
      method: 'POST',
      url: `/sync/replicas/${CAMPAIGN}/ack`,
      headers: authenticatedHeaders,
      payload: {
        replicaId: REPLICA,
        tableName: 'campaigns',
        sequence: 4,
        pendingRecordIds: [record],
      },
    });
    expect(ack.statusCode).toBe(204);
    expect(watermarks).toEqual([
      {
        campaignId: CAMPAIGN,
        userId: USER,
        replicaId: REPLICA,
        tableName: 'campaigns',
        sequence: 4,
        pendingRecordIds: [record],
      },
    ]);
    revoke();
    const denied = await app.inject({
      method: 'POST',
      url: `/sync/replicas/${CAMPAIGN}/ack`,
      headers: authenticatedHeaders,
      payload: { replicaId: REPLICA, tableName: 'campaigns', sequence: 5 },
    });
    expect(denied.statusCode).toBe(404);
    const dropped = await app.inject({
      method: 'DELETE',
      url: `/sync/replicas/${CAMPAIGN}`,
      headers: authenticatedHeaders,
      payload: { replicaId: REPLICA },
    });
    expect(dropped.statusCode).toBe(204);
    expect(watermarks).toHaveLength(2);
    await app.close();
  });

  test('audit acknowledgement names an event; the authority resolves its sequence', async () => {
    const { app, revoke, watermarks, auditResolutions } = setup();
    const ack = (payload: object) =>
      app.inject({
        method: 'POST',
        url: `/sync/replicas/${CAMPAIGN}/ack`,
        headers: authenticatedHeaders,
        payload,
      });
    const held = await ack({
      replicaId: REPLICA,
      tableName: 'audit_campaign_events',
      throughEventId: HELD_EVENT,
    });
    expect(held.statusCode).toBe(204);
    expect(held.body).toBe('');
    expect(auditResolutions).toEqual([
      {
        actor: { userId: USER, campaignId: CAMPAIGN, role: 'gm' },
        tableName: 'audit_campaign_events',
        eventId: HELD_EVENT,
      },
    ]);
    expect(watermarks).toEqual([
      {
        campaignId: CAMPAIGN,
        userId: USER,
        replicaId: REPLICA,
        tableName: 'audit_campaign_events',
        sequence: 42,
      },
    ]);
    // Unknown, hidden, or private-to-others events answer the same 204 and record nothing.
    const unknown = await ack({
      replicaId: REPLICA,
      tableName: 'audit_private_events',
      throughEventId: HELD_EVENT,
    });
    expect(unknown.statusCode).toBe(204);
    expect(unknown.body).toBe('');
    expect(watermarks).toHaveLength(1);
    // A device never supplies an audit sequence, and never mixes both shapes.
    for (const payload of [
      { replicaId: REPLICA, tableName: 'audit_campaign_events', sequence: 9_999 },
      { replicaId: REPLICA, tableName: 'audit_private_events', sequence: 1 },
      {
        replicaId: REPLICA,
        tableName: 'audit_campaign_events',
        throughEventId: HELD_EVENT,
        sequence: 9_999,
      },
      { replicaId: REPLICA, tableName: 'audit_account_events', throughEventId: HELD_EVENT },
      { replicaId: REPLICA, tableName: 'campaigns', throughEventId: HELD_EVENT },
      { replicaId: REPLICA, tableName: 'audit_campaign_events', throughEventId: 'not-an-id' },
    ]) {
      expect((await ack(payload)).statusCode).toBe(400);
    }
    expect(watermarks).toHaveLength(1);
    expect(auditResolutions).toHaveLength(2);
    revoke();
    const denied = await ack({
      replicaId: REPLICA,
      tableName: 'audit_campaign_events',
      throughEventId: HELD_EVENT,
    });
    expect(denied.statusCode).toBe(404);
    expect(auditResolutions).toHaveLength(2);
    await app.close();
  });

  test('bootstrap requires current membership and returns scoped short-lived credentials', async () => {
    const { app, revoke } = setup();
    const response = await app.inject({
      method: 'GET',
      url: `/sync/bootstrap/${CAMPAIGN}`,
      headers: { cookie: `rpg_session=${CREDENTIAL}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      campaignId: CAMPAIGN,
      endpoint: 'http://localhost:8080',
      token: 'signed-token',
    });
    revoke();
    const denied = await app.inject({
      method: 'GET',
      url: `/sync/bootstrap/${CAMPAIGN}`,
      headers: { cookie: `rpg_session=${CREDENTIAL}` },
    });
    expect(denied.statusCode).toBe(404);
    await app.close();
  });

  test('upload applies only registered operations in causal order', async () => {
    const { app, sessions } = setup();
    const response = await app.inject({
      method: 'POST',
      url: '/sync/mutations',
      headers: authenticatedHeaders,
      payload: {
        campaignId: CAMPAIGN,
        replicaId: REPLICA,
        mutations: [mutation(1), mutation(2)],
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().outcomes).toMatchObject([
      { status: 'accepted', acceptedVersion: 2 },
      { status: 'accepted', acceptedVersion: 2 },
    ]);
    // B-2: appliers receive the authenticated session, never a payload value.
    expect(sessions).toEqual([SESSION, SESSION]);
    const arbitrary = await app.inject({
      method: 'POST',
      url: '/sync/mutations',
      headers: authenticatedHeaders,
      payload: {
        campaignId: CAMPAIGN,
        replicaId: REPLICA,
        mutations: [{ ...mutation(1), tableName: 'unknown_table' }],
      },
    });
    expect(arbitrary.json().outcomes[0]).toMatchObject({
      status: 'error',
      code: 'unregistered_mutation',
    });
    await app.close();
  });

  test('revoked upload fails closed despite the authenticated session', async () => {
    const { app, revoke } = setup();
    revoke();
    const response = await app.inject({
      method: 'POST',
      url: '/sync/mutations',
      headers: authenticatedHeaders,
      payload: { campaignId: CAMPAIGN, replicaId: REPLICA, mutations: [mutation(1)] },
    });
    expect(response.json().outcomes[0]).toMatchObject({
      status: 'error',
      code: 'not_found_or_forbidden',
    });
    await app.close();
  });

  test('upload schema rejects arbitrary table, column, and SQL shapes before authority', async () => {
    const { app } = setup();
    for (const mutations of [
      [{ ...mutation(1), tableName: 'identity_sessions; drop table campaigns' }],
      [{ ...mutation(1), columns: ['password_hash'] }],
      [{ ...mutation(1), sql: 'update campaigns set name = 1' }],
      [{ ...mutation(1), operation: 'upsert_any' }],
      [],
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: '/sync/mutations',
        headers: authenticatedHeaders,
        payload: { campaignId: CAMPAIGN, replicaId: REPLICA, mutations },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('validation_failed');
    }
    await app.close();
  });

  test('out-of-order batch and cross-campaign items are refused per item', async () => {
    const { app } = setup();
    const unordered = await app.inject({
      method: 'POST',
      url: '/sync/mutations',
      headers: authenticatedHeaders,
      payload: { campaignId: CAMPAIGN, replicaId: REPLICA, mutations: [mutation(2), mutation(1)] },
    });
    expect(unordered.json().outcomes.map((item: { code: string }) => item.code)).toEqual([
      'causal_order_invalid',
      'causal_order_invalid',
    ]);
    const crossCampaign = await app.inject({
      method: 'POST',
      url: '/sync/mutations',
      headers: authenticatedHeaders,
      payload: {
        campaignId: CAMPAIGN,
        replicaId: REPLICA,
        mutations: [{ ...mutation(1), campaignId: crypto.randomUUID() }],
      },
    });
    expect(crossCampaign.json().outcomes[0]).toMatchObject({ code: 'not_found_or_forbidden' });
    await app.close();
  });

  test('reconnect replay of a batch returns the same outcomes without reapplying', async () => {
    const { app } = setup();
    const payload = { campaignId: CAMPAIGN, replicaId: REPLICA, mutations: [mutation(1)] };
    const first = await app.inject({
      method: 'POST',
      url: '/sync/mutations',
      headers: authenticatedHeaders,
      payload,
    });
    const replay = await app.inject({
      method: 'POST',
      url: '/sync/mutations',
      headers: authenticatedHeaders,
      payload,
    });
    expect(replay.json()).toEqual(first.json());
    await app.close();
  });

  test('upload requires a session and same-origin request', async () => {
    const { app } = setup();
    const payload = { campaignId: CAMPAIGN, replicaId: REPLICA, mutations: [mutation(1)] };
    const anonymous = await app.inject({
      method: 'POST',
      url: '/sync/mutations',
      headers: { origin: ORIGIN },
      payload,
    });
    expect(anonymous.statusCode).toBe(401);
    const crossSite = await app.inject({
      method: 'POST',
      url: '/sync/mutations',
      headers: { ...authenticatedHeaders, origin: 'https://evil.example' },
      payload,
    });
    expect(crossSite.statusCode).toBe(403);
    await app.close();
  });

  test('hold takeover invalidates the previous holder version', async () => {
    const { app } = setup();
    const field = {
      resourceClass: 'session_note',
      recordId: '00000000-0000-4000-8000-000000000005',
      fieldPath: 'body',
    };
    const acquired = await app.inject({
      method: 'POST',
      url: `/sync/holds/${CAMPAIGN}/acquire`,
      headers: authenticatedHeaders,
      payload: field,
    });
    expect(acquired.statusCode).toBe(200);
    const first = acquired.json().hold;
    const takeover = await app.inject({
      method: 'POST',
      url: `/sync/holds/${CAMPAIGN}/takeover`,
      headers: authenticatedHeaders,
      payload: field,
    });
    expect(takeover.json().hold.version).toBe(first.version + 1);
    const staleRenewal = await app.inject({
      method: 'POST',
      url: `/sync/holds/${CAMPAIGN}/renew`,
      headers: authenticatedHeaders,
      payload: { ...field, expectedVersion: first.version },
    });
    expect(staleRenewal.statusCode).toBe(409);
    await app.close();
  });

  test('every hold route asks feature 04 for update on the held record and hides a denial', async () => {
    const { app, decisions, hide } = setup();
    const field = {
      resourceClass: 'session_note',
      recordId: '00000000-0000-4000-8000-000000000006',
      fieldPath: 'body',
    };
    const acquired = await app.inject({
      method: 'POST',
      url: `/sync/holds/${CAMPAIGN}/acquire`,
      headers: authenticatedHeaders,
      payload: field,
    });
    expect(acquired.statusCode).toBe(200);
    expect(decisions).toEqual([
      {
        userId: USER,
        campaignId: CAMPAIGN,
        resourceClass: 'session_note',
        resourceId: field.recordId,
        capability: 'update',
      },
    ]);
    const version = acquired.json().hold.version;
    const nonMember = await app.inject({
      method: 'POST',
      url: `/sync/holds/00000000-0000-4000-8000-000000000099/acquire`,
      headers: authenticatedHeaders,
      payload: field,
    });
    hide(field.recordId);
    const responses = await Promise.all([
      ...['acquire', 'takeover'].map((action) =>
        app.inject({
          method: 'POST',
          url: `/sync/holds/${CAMPAIGN}/${action}`,
          headers: authenticatedHeaders,
          payload: field,
        }),
      ),
      ...['renew', 'release'].map((action) =>
        app.inject({
          method: 'POST',
          url: `/sync/holds/${CAMPAIGN}/${action}`,
          headers: authenticatedHeaders,
          payload: { ...field, expectedVersion: version },
        }),
      ),
    ]);
    for (const response of responses) {
      expect(response.statusCode).toBe(404);
      expect(response.body).toBe(nonMember.body);
      expect(response.body).not.toContain(USER);
    }
    expect(decisions).toHaveLength(6);
    await app.close();
  });
});

function mutation(causalSequence: number) {
  return {
    mutationId: crypto.randomUUID(),
    campaignId: CAMPAIGN,
    featureId: 'entities',
    tableName: 'entities',
    recordId: crypto.randomUUID(),
    operation: 'update',
    expectedVersion: 1,
    payload: { name: 'value' },
    causalSequence,
    state: 'pending',
    attemptCount: 0,
    recordedAt: '2026-08-31T10:00:00Z',
  };
}
