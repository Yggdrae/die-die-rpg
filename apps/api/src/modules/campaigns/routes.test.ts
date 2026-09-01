import { describe, expect, test } from 'bun:test';
import {
  CampaignService,
  CampaignSettingRegistry,
  InMemoryCampaignRepository,
  type SystemCatalog,
  type SystemDefinition,
} from '@rpg/campaigns';
import { err, ok } from '@rpg/contracts';
import type { CampaignMembershipWriter } from '@rpg/identity';
import { buildApp } from '../../app.ts';
import { registerIdentityAuthentication } from '../identity/authenticate.ts';
import { registerCampaignRoutes } from './routes.ts';

const userId = '22222222-2222-2222-2222-222222222222';
const sessionId = '33333333-3333-3333-3333-333333333333';
const campaignId = '11111111-1111-1111-1111-111111111111';
const credential = 'A'.repeat(43);
const origin = 'https://table.invalid';

const system: SystemDefinition = {
  summary: {
    ref: { systemId: 'fixture-system', version: '0.1.0' },
    name: 'Fixture',
    shortDescription: 'Fixture system.',
    complexity: 'low',
    documentationStatus: 'external',
    rulesEntryPoint: 'https://example.invalid/rules',
    integration: {
      mechanicsSupported: true,
      characterSheetSupported: true,
      rulesTextIntegrated: false,
      compendiumIntegrated: false,
      externalDocumentation: 'https://example.invalid/rules',
    },
  },
  gameModes: [{ id: 'standard', label: 'Standard' }],
  options: [],
  compatibleModules: [],
};

function appHarness() {
  const app = buildApp();
  registerIdentityAuthentication(app, {
    authenticate: async (candidate) =>
      candidate === credential ? { userId, sessionId } : undefined,
  });
  const catalog: SystemCatalog = {
    list: async () => [system.summary],
    resolveExact: async (ref) =>
      ref.systemId === system.summary.ref.systemId && ref.version === system.summary.ref.version
        ? system
        : undefined,
    resolveLatest: async () => system,
  };
  const ownerWriter: CampaignMembershipWriter = {
    createOwner: (input, transaction) => {
      const handle = transaction.handle as {
        insertOwner(candidate: typeof input): ReturnType<CampaignMembershipWriter['createOwner']>;
      };
      return handle.insertOwner(input);
    },
  };
  const campaigns = new CampaignService(
    new InMemoryCampaignRepository(),
    catalog,
    {
      resolve: async (candidateUserId, candidateCampaignId) =>
        candidateUserId === userId && candidateCampaignId === campaignId
          ? ok({ userId, campaignId, role: 'owner' })
          : err('membership_not_found'),
      listCampaignIds: async (candidateUserId) => (candidateUserId === userId ? [campaignId] : []),
    },
    ownerWriter,
    { decide: (actor) => actor.role === 'owner' },
    new CampaignSettingRegistry(),
    { record: async () => undefined },
    { auditDegraded: () => undefined },
  );
  registerCampaignRoutes(app, { campaigns, systems: catalog }, { allowedOrigin: origin });
  return app;
}

const body = {
  id: campaignId,
  system: system.summary.ref,
  gameMode: 'standard',
  options: {},
  moduleIds: [],
  name: 'Road Game',
  description: '',
};

describe('Fastify campaign routes', () => {
  test('requires an authoritative session and same origin for mutation', async () => {
    const app = appHarness();
    const unauthenticated = await app.inject({ method: 'POST', url: '/campaigns', payload: body });
    const crossOrigin = await app.inject({
      method: 'POST',
      url: '/campaigns',
      headers: { cookie: `rpg_session=${credential}`, origin: 'https://attacker.invalid' },
      payload: body,
    });
    const accepted = await app.inject({
      method: 'POST',
      url: '/campaigns',
      headers: { cookie: `rpg_session=${credential}`, origin },
      payload: body,
    });

    expect(unauthenticated.statusCode).toBe(401);
    expect(crossOrigin.statusCode).toBe(403);
    expect(accepted.statusCode).toBe(201);
    expect(accepted.body).not.toContain(credential);
    await app.close();
  });

  test('rejects client role claims before application use', async () => {
    const app = appHarness();
    const response = await app.inject({
      method: 'POST',
      url: '/campaigns',
      headers: { cookie: `rpg_session=${credential}`, origin },
      payload: { ...body, role: 'owner' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'validation_failed' });
    await app.close();
  });

  test('non-member and missing campaign use the same public result', async () => {
    const app = appHarness();
    const missing = await app.inject({
      method: 'GET',
      url: '/campaigns/44444444-4444-4444-4444-444444444444',
      headers: { cookie: `rpg_session=${credential}` },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ code: 'not_found_or_forbidden' });
    await app.close();
  });
});
