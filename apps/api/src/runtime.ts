import { AuthorizationService, ResourcePolicyRegistry } from '@rpg/authorization';
import {
  CampaignService,
  CampaignSettingRegistry,
  connectCampaignDatabase,
  PostgresCampaignRepository,
  StaticSystemCatalog,
} from '@rpg/campaigns';
import type { AuditRecorder, CampaignAccessRevocationPublisher } from '@rpg/contracts';
import { FIXTURE_SYSTEM_DEFINITION } from '@rpg/fixtures';
import { createPostgresIdentityRuntime } from '@rpg/identity';
import {
  AuthorityMutationService,
  LongTextHoldService,
  MutationApplierRegistry,
  SyncBootstrapService,
} from '@rpg/sync';
import {
  connectSyncDatabase,
  PostgresLongTextHoldRepository,
  PostgresMutationReceiptStore,
  PostgresWatermarkStore,
} from '@rpg/sync/postgres';
import { buildApp } from './app.ts';
import { registerCampaignRoutes } from './modules/campaigns/routes.ts';
import { registerIdentityAuthentication } from './modules/identity/authenticate.ts';
import { registerIdentityRoutes } from './modules/identity/routes.ts';
import { CampaignSyncMutationApplier } from './modules/sync/campaign-applier.ts';
import { registerSyncRoutes } from './modules/sync/routes.ts';
import { HmacSyncTokenIssuer } from './modules/sync/token.ts';

export function buildRuntimeApp(input: {
  readonly databaseUrl: string;
  readonly allowedOrigin: string;
  readonly production: boolean;
  readonly powerSyncEndpoint: string;
  readonly powerSyncJwtSecret: string;
  readonly version?: string;
}) {
  const app = buildApp({ logger: true, version: input.version });
  const campaignConnection = connectCampaignDatabase(input.databaseUrl);
  const syncConnection = connectSyncDatabase(input.databaseUrl);
  const repository = new PostgresCampaignRepository(campaignConnection.db);
  const catalog = new StaticSystemCatalog([FIXTURE_SYSTEM_DEFINITION]);
  const audit: AuditRecorder = {
    record: async (event) => {
      app.log.info(
        { action: event.action, campaignId: event.campaignId, targetId: event.targetId },
        'audit event pending durable feature-06 adapter',
      );
    },
  };
  const revocations: CampaignAccessRevocationPublisher = {
    publish: async (event) => {
      app.log.info(
        {
          campaignId: event.campaignId,
          userId: event.userId,
          membershipVersion: event.membershipVersion,
          reason: event.reason,
        },
        'campaign access revocation pending feature-03 delivery',
      );
    },
  };
  const identity = createPostgresIdentityRuntime({
    connectionString: input.databaseUrl,
    campaignNames: {
      getDisplayName: async (campaignId) => (await repository.get(campaignId))?.name,
    },
    audit,
    revocations,
    recoveryAudit: {
      recordIssued: async (event) =>
        app.log.info(
          { tokenId: event.tokenId, userId: event.userId, issuedAt: event.issuedAt },
          'recovery issuance audit pending durable feature-06 adapter',
        ),
    },
    authenticationLog: {
      accountCreated: (userId) => app.log.info({ userId }, 'account created'),
      loginSucceeded: (userId, sessionId) => app.log.info({ userId, sessionId }, 'login succeeded'),
      loginFailed: () => app.log.warn('login failed'),
      sessionRevoked: (sessionId) => app.log.info({ sessionId }, 'session revoked'),
    },
    recoveryLog: {
      recoveryIssued: (userId, tokenId) => app.log.info({ userId, tokenId }, 'recovery issued'),
      recoveryIssuanceAuditDegraded: (tokenId) =>
        app.log.error({ tokenId }, 'recovery audit degraded'),
      recoverySucceeded: (userId, tokenId) =>
        app.log.info({ userId, tokenId }, 'recovery succeeded'),
      recoveryFailed: () => app.log.warn('recovery failed'),
    },
    membershipLog: {
      integrationDegraded: (integration, campaignId, userId) =>
        app.log.error({ integration, campaignId, userId }, 'membership integration degraded'),
    },
  });
  const settings = new CampaignSettingRegistry();
  const policies = new ResourcePolicyRegistry();
  policies.register({
    resourceClass: 'campaign',
    capabilities: ['read', 'update', 'delete', 'update_system', 'write_setting'],
    roleCapabilities: {
      owner: ['read', 'update', 'delete', 'update_system', 'write_setting'],
      gm: ['read', 'write_setting'],
      assistant_gm: ['read', 'write_setting'],
      player: ['read', 'write_setting'],
      observer: [],
    },
  });
  const authorization = new AuthorizationService(policies);
  const campaigns = new CampaignService(
    repository,
    catalog,
    identity.memberships,
    identity.membershipWriter,
    {
      decide: (actor, capability) =>
        authorization.decide(actor, capability, {
          campaignId: actor.campaignId,
          resourceClass: 'campaign',
          resourceId: actor.campaignId,
          visibility: { mode: 'everyone' },
          version: 1,
        }).allowed,
    },
    settings,
    audit,
    {
      auditDegraded: (action, campaignId) =>
        app.log.error({ action, campaignId }, 'campaign audit degraded'),
    },
  );
  const syncAccess = {
    resolve: async (userId: string, campaignId: string) => {
      const actor = await identity.memberships.resolve(userId, campaignId);
      return actor.ok ? actor.value : undefined;
    },
  };
  const mutationAppliers = new MutationApplierRegistry();
  mutationAppliers.register(new CampaignSyncMutationApplier(campaigns));
  const syncMutations = new AuthorityMutationService(
    syncAccess,
    mutationAppliers,
    new PostgresMutationReceiptStore(syncConnection.db),
  );
  const syncBootstrap = new SyncBootstrapService(
    syncAccess,
    input.powerSyncEndpoint,
    new HmacSyncTokenIssuer(input.powerSyncJwtSecret),
  );

  registerIdentityAuthentication(app, identity.accounts);
  registerIdentityRoutes(app, identity, {
    allowedOrigin: input.allowedOrigin,
    secureCookies: input.production,
  });
  registerCampaignRoutes(
    app,
    { campaigns, systems: catalog },
    { allowedOrigin: input.allowedOrigin },
  );
  registerSyncRoutes(
    app,
    {
      access: syncAccess,
      bootstrap: syncBootstrap,
      mutations: syncMutations,
      holds: new LongTextHoldService(new PostgresLongTextHoldRepository(syncConnection.db)),
      watermarks: new PostgresWatermarkStore(syncConnection.db),
    },
    { allowedOrigin: input.allowedOrigin },
  );

  app.addHook('onClose', async () => {
    await identity.close();
    await campaignConnection.close();
    await syncConnection.close();
  });
  return app;
}
