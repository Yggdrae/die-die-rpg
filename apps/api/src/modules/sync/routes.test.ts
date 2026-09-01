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
  registry.register({
    featureId: 'entities',
    tableName: 'entities',
    apply: async ({ mutation }) => ({
      status: 'accepted',
      version: (mutation.expectedVersion ?? 0) + 1,
      cursor: `cursor-${mutation.causalSequence}`,
    }),
  });
  const watermarks: unknown[] = [];
  registerSyncRoutes(
    app,
    {
      access,
      bootstrap: new SyncBootstrapService(access, 'http://localhost:8080', {
        issue: async () => 'signed-token',
      }),
      mutations: new AuthorityMutationService(access, registry, new InMemoryMutationReceiptStore()),
      holds: new LongTextHoldService(new InMemoryLongTextHoldRepository()),
      watermarks: {
        acknowledge: async (input) => void watermarks.push(input),
        replicaDropped: async (input) => void watermarks.push(input),
      },
    },
    { allowedOrigin: ORIGIN },
  );
  return {
    app,
    revoke: () => {
      active = false;
    },
    watermarks,
  };
}

const authenticatedHeaders = {
  cookie: `rpg_session=${CREDENTIAL}`,
  origin: ORIGIN,
};

describe('sync routes', () => {
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
    const { app } = setup();
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
