import {
  connectActionsDatabase,
  EffectApplicationService,
  type EffectTargetAdapter,
  effectFactsSource,
  PostgresEffectRepository,
} from '@rpg/actions/postgres';
import {
  AttachmentCleanup,
  AttachmentReconciler,
  AttachmentService,
  type ObjectStorage,
  UnconfiguredObjectStorage,
} from '@rpg/attachments';
import { connectAttachmentDatabase, PostgresAttachmentRepository } from '@rpg/attachments/postgres';
import { createPostgresAuditRuntime } from '@rpg/audit';
import {
  AuthorizationService,
  ResourcePolicyRegistry,
  VisibilityService,
} from '@rpg/authorization';
import {
  connectPortabilityDatabase,
  importTransactionHandle,
  PostgresExportJobRepository,
  PostgresImportCommitStore,
  PostgresImportJobRepository,
  PostgresImportTransactions,
  PostgresPreservedChunkSource,
} from '@rpg/campaign-portability/postgres';
import {
  CampaignImporter,
  CampaignService,
  CampaignSettingRegistry,
  connectCampaignDatabase,
  PostgresCampaignRepository,
  StaticSystemCatalog,
  type SystemDefinition,
} from '@rpg/campaigns';
import { CharacterExporter, characterFacts } from '@rpg/characters';
import {
  CharacterService,
  characterTargetAdapter,
  connectCharactersDatabase,
  PostgresCharacterImportWriter,
  PostgresCharacterRepository,
} from '@rpg/characters/postgres';
import { ContentExporter } from '@rpg/content';
import {
  connectContentDatabase,
  EntityService,
  EntityVisibilityAdapter,
  PersonalNoteService,
  PostgresContentImportWriter,
  PostgresEntityRepository,
  PostgresPersonalNoteRepository,
  PostgresRelationshipRepository,
  personalNoteFactsSource,
  RelationshipService,
  RelationshipVisibilityAdapter,
} from '@rpg/content/postgres';
import type { AuditRecorder, CampaignAccessRevocationPublisher } from '@rpg/contracts';
import { RollExporter } from '@rpg/dice';
import {
  connectDiceDatabase,
  PostgresDiceImportWriter,
  PostgresRollRepository,
  RollService,
} from '@rpg/dice/postgres';
import {
  ENCOUNTER_NOTE_REPLICA_TABLE,
  ENCOUNTER_REPLICA_TABLE,
  EncounterExporter,
  PARTICIPANT_REPLICA_TABLE,
} from '@rpg/encounters';
import {
  connectEncountersDatabase,
  EncounterService,
  encounterParticipantTargetAdapter,
  PostgresEncounterImportWriter,
  PostgresEncounterRepository,
} from '@rpg/encounters/postgres';
import { createPostgresIdentityRuntime, type RecoveryIssuanceAudit } from '@rpg/identity';
import {
  connectRulesDatabase,
  PostgresRulesMarkRepository,
  RulesMarkService,
} from '@rpg/rules/postgres';
import {
  SESSION_LOG_REPLICA_TABLE,
  SESSION_NOTE_REPLICA_TABLE,
  SESSION_REPLICA_TABLE,
  SessionExporter,
} from '@rpg/sessions';
import {
  connectSessionsDatabase,
  PostgresSessionImportWriter,
  PostgresSessionRepository,
  SessionService,
} from '@rpg/sessions/postgres';
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
import { type BuildOptions, buildApp } from './app.ts';
import { EffectApplicationSyncMutationApplier } from './modules/actions/appliers.ts';
import { contentAccessAttachmentAuthorizer } from './modules/attachments/authorizer.ts';
import { registerAttachmentRoutes } from './modules/attachments/routes.ts';
import {
  auditDiagnosticsFor,
  auditTargetDeclarationsFor,
  DISCARD_AUDIT,
  membershipAuditRecorderFor,
  mutationAuditParticipantFor,
  recordOnlyMutationAuditParticipant,
  recoveryIssuanceAuditFor,
} from './modules/audit/composition.ts';
import { createAuditRendererRegistry } from './modules/audit/contributors.ts';
import { membershipFactsSource } from './modules/audit/membership-facts.ts';
import {
  auditAcknowledgementsFor,
  auditReplicaEligibility,
} from './modules/audit/replica-acknowledgement.ts';
import { createAuditRetention, startAuditRetention } from './modules/audit/retention.ts';
import { registerAuditRoutes } from './modules/audit/routes.ts';
import { AuditTargetAccess } from './modules/audit/target-access.ts';
import { ContentAccess, type ResourceFactsSource } from './modules/authorization/content-access.ts';
import { DenialTelemetry } from './modules/authorization/denial-telemetry.ts';
import { registerVisibilityRoutes } from './modules/authorization/visibility-routes.ts';
import { campaignAccessPolicy } from './modules/campaigns/access.ts';
import { campaignFactsSource } from './modules/campaigns/facts.ts';
import { registerCampaignRoutes } from './modules/campaigns/routes.ts';
import { CharacterSyncMutationApplier } from './modules/characters/appliers.ts';
import {
  EntitySyncMutationApplier,
  PersonalNoteSyncMutationApplier,
  RelationshipSyncMutationApplier,
} from './modules/content/appliers.ts';
import { registerContentRoutes } from './modules/content/routes.ts';
import { DiceRollSyncMutationApplier } from './modules/dice/appliers.ts';
import { EncounterSyncMutationApplier } from './modules/encounters/appliers.ts';
import { registerIdentityAuthentication } from './modules/identity/authenticate.ts';
import { registerIdentityRoutes } from './modules/identity/routes.ts';
import {
  createCampaignImport,
  createOnlineExport,
  exportJobAttachmentReferences,
  startExportJobRetention,
} from './modules/portability/composition.ts';
import { registerPortabilityRoutes } from './modules/portability/routes.ts';
import { RulesMarkSyncMutationApplier } from './modules/rules/appliers.ts';
import { SessionSyncMutationApplier } from './modules/sessions/appliers.ts';
import {
  CampaignSettingSyncMutationApplier,
  CampaignSyncMutationApplier,
} from './modules/sync/campaign-applier.ts';
import { createRevocationDelivery } from './modules/sync/revocation.ts';
import { registerSyncRoutes } from './modules/sync/routes.ts';
import { registerResourcePolicies } from './modules/sync/sync-rules.ts';
import { HmacSyncTokenIssuer } from './modules/sync/token.ts';
import { installedSystemDefinitions, loadedRegistry } from './modules/systems/registry.ts';

export function buildRuntimeApp(input: {
  readonly databaseUrl: string;
  readonly allowedOrigin: string;
  readonly production: boolean;
  readonly powerSyncEndpoint: string;
  readonly powerSyncJwtSecret: string;
  readonly version?: string;
  /** `true` (default) logs to stdout; a stream captures log lines (tests). */
  readonly logger?: BuildOptions['logger'];
  /** Installed system definitions. Defaults to the fixture system until feature 08 ships a registry. */
  readonly systems?: readonly SystemDefinition[];
  /**
   * Feature 11: what effects can change, by target class. Each owner registers its own adapter; until
   * feature 15 does, an uploaded application is refused with `unknown_target`.
   */
  readonly effectTargets?: readonly EffectTargetAdapter[];
  /**
   * Integration overrides. Audit defaults to the durable feature 06 recorder; revocation to the
   * durable feature 03 delivery (outbox + subscription invalidation, retried).
   */
  readonly integrations?: {
    readonly audit?: AuditRecorder;
    readonly recoveryAudit?: RecoveryIssuanceAudit;
    readonly revocations?: CampaignAccessRevocationPublisher;
  };
  /** Audit retry pass interval. Default 30 s. */
  readonly auditRetryIntervalMs?: number;
  /**
   * Feature 06 server retention (365 days). Deletion is OFF unless `delete` is exactly `true`;
   * then a pass runs every `intervalMs` (default 24 h) in bounded batches. Without it nothing
   * is deleted and the report stays available through the retention CLI.
   */
  readonly auditRetention?: {
    readonly delete?: boolean;
    readonly intervalMs?: number;
    readonly batchSize?: number;
    readonly maxBatches?: number;
  };
  /** Revocation delivery retry pass interval. Default 30 s. */
  readonly revocationRetryIntervalMs?: number;
  /** Aggregated authorization-denial log interval. Default 60 s. */
  readonly denialReportIntervalMs?: number;
  /**
   * Feature 05. `storage` is the `ObjectStorage` adapter (main.ts passes the S3-compatible one);
   * without it every storage operation is a provider fault. `ownerClasses` lists the Resource
   * Classes that accept attachments: none until a content owner (feature 16+) registers its own.
   */
  readonly attachments?: {
    readonly storage?: ObjectStorage;
    readonly ownerClasses?: readonly string[];
    /** Abandoned-upload cleanup and retention reconciliation interval. Default 1 h. */
    readonly cleanupIntervalMs?: number;
  };
  /** Feature 07. Export and import job metadata retention pass interval. Default 1 h. */
  readonly exportRetentionIntervalMs?: number;
}) {
  const app = buildApp({ logger: input.logger ?? true, version: input.version });
  const campaignConnection = connectCampaignDatabase(input.databaseUrl);
  const syncConnection = connectSyncDatabase(input.databaseUrl);
  const attachmentConnection = connectAttachmentDatabase(input.databaseUrl);
  const portabilityConnection = connectPortabilityDatabase(input.databaseUrl);
  // Feature 16: campaign entities (`campaign_entity`, Visibility adapter) and personal notes.
  const contentConnection = connectContentDatabase(input.databaseUrl);
  const entities = new PostgresEntityRepository(contentConnection.db);
  const personalNotes = new PostgresPersonalNoteRepository(contentConnection.db);
  const relationships = new PostgresRelationshipRepository(contentConnection.db);
  const diceConnection = connectDiceDatabase(input.databaseUrl);
  const rolls = new PostgresRollRepository(diceConnection.db);
  const actionsConnection = connectActionsDatabase(input.databaseUrl);
  const effectApplications = new PostgresEffectRepository(actionsConnection.db);
  const charactersConnection = connectCharactersDatabase(input.databaseUrl);
  const characterRecords = new PostgresCharacterRepository(charactersConnection.db);
  const sessionsConnection = connectSessionsDatabase(input.databaseUrl);
  const sessionRecords = new PostgresSessionRepository(sessionsConnection.db);
  const encountersConnection = connectEncountersDatabase(input.databaseUrl);
  const encounterRecords = new PostgresEncounterRepository(encountersConnection.db);
  const rulesConnection = connectRulesDatabase(input.databaseUrl);
  const rulesMarks = new PostgresRulesMarkRepository(rulesConnection.db);
  // Feature 15: the packages characters are interpreted by, validated by every engine at load.
  const systemRegistry = loadedRegistry();
  const repository = new PostgresCampaignRepository(campaignConnection.db);
  const catalog = new StaticSystemCatalog(input.systems ?? installedSystemDefinitions());
  // Every reveal-capable class must register its adapter; the startup fails otherwise.
  // Same declarations the sync-config drift test compiles.
  const policies = registerResourcePolicies(
    new ResourcePolicyRegistry({ requireVisibilityAdapters: true }),
    [
      // Narrowing an entity narrows its relationships in the same transaction (D-07 option A),
      // audited through the feature 06 recorder composed below.
      new EntityVisibilityAdapter(entities, {
        relationships,
        audit: {
          recordWithin: (executor, submission) =>
            durableAudit.recorder.recordWithin(executor, submission),
        },
      }),
      new RelationshipVisibilityAdapter(relationships, entities),
    ],
  );
  const durableAudit = createPostgresAuditRuntime({
    connectionString: input.databaseUrl,
    diagnostics: auditDiagnosticsFor(app.log),
    // Feature 06 task 06: every contributor's payload schema and renderer.
    registry: createAuditRendererRegistry(),
    // Undescribed audit targets take their snapshot from these declarations, else GM-only.
    targets: auditTargetDeclarationsFor(policies),
  });
  const stopAuditRetry = durableAudit.recorder.startRetryLoop(input.auditRetryIntervalMs);
  const audit: AuditRecorder = input.integrations?.audit ?? durableAudit.recorder;
  const revocationDelivery = createRevocationDelivery(syncConnection.db, app.log);
  const stopRevocationRetry =
    input.integrations?.revocations === undefined
      ? revocationDelivery.publisher.startRetryLoop(input.revocationRetryIntervalMs)
      : () => undefined;
  const revocations: CampaignAccessRevocationPublisher =
    input.integrations?.revocations ?? revocationDelivery.publisher;
  const identity = createPostgresIdentityRuntime({
    connectionString: input.databaseUrl,
    campaignNames: {
      getDisplayName: async (campaignId) => (await repository.get(campaignId))?.name,
    },
    audit: input.integrations?.audit ?? membershipAuditRecorderFor(durableAudit.recorder),
    revocations,
    recoveryAudit:
      input.integrations?.recoveryAudit ?? recoveryIssuanceAuditFor(durableAudit.recorder),
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
      integrationDegraded: (integration, campaignId, userId, detail) =>
        app.log.error(
          { integration, campaignId, userId, ...detail },
          'membership integration degraded',
        ),
    },
  });
  const settings = new CampaignSettingRegistry();
  const authorization = new AuthorizationService(policies);
  // Aggregated by class and reason; no actor identifier can be recorded.
  const denialTelemetry = new DenialTelemetry();
  const stopDenialReport = denialTelemetry.startReporting(
    (denials) => app.log.info({ denials }, 'authorization denial totals'),
    input.denialReportIntervalMs,
  );
  // `personal_note` has no reveal, so no adapter: its facts (author included) come from here.
  const factsSources: readonly ResourceFactsSource[] = [
    campaignFactsSource(repository),
    personalNoteFactsSource(personalNotes),
    effectFactsSource(effectApplications),
    {
      resourceClass: 'character',
      loadFacts: async (campaignId: string, resourceId: string) => {
        const record = await characterRecords.get(campaignId, resourceId);
        return record === undefined || record.deletedAt !== undefined
          ? undefined
          : characterFacts(record);
      },
    },
  ];
  const contentAccess = new ContentAccess({
    registry: policies,
    actors: identity.memberships,
    sources: factsSources,
    // Class and reason only; the actor is never logged with a denial.
    onDenied: (resourceClass, reason) => {
      denialTelemetry.record(resourceClass, reason);
      app.log.info({ resourceClass, reason }, 'authorization denied');
    },
  });
  const visibility = new VisibilityService({
    registry: policies,
    actors: identity.memberships,
    audit: durableAudit.recorder,
  });
  const campaignService = (recorder: AuditRecorder) =>
    new CampaignService(
      repository,
      catalog,
      identity.memberships,
      identity.membershipWriter,
      campaignAccessPolicy(authorization, settings),
      settings,
      recorder,
      {
        auditDegraded: (action, campaignId) =>
          app.log.error({ action, campaignId }, 'campaign audit degraded'),
      },
    );
  const campaigns = campaignService(audit);
  // Synced mutations carry their audit envelope: the sync service records it once, keyed by the
  // client mutation ID, so the domain service must not also record post-commit.
  const campaignsWithoutServiceAudit = campaignService(DISCARD_AUDIT);
  const syncAccess = {
    resolve: async (userId: string, campaignId: string) => {
      const actor = await identity.memberships.resolve(userId, campaignId);
      return actor.ok ? actor.value : undefined;
    },
    resolveWithin: async (transaction: unknown, userId: string, campaignId: string) => {
      const actor = await identity.memberships.resolveWithin(transaction, userId, campaignId);
      return actor.ok ? actor.value : undefined;
    },
  };
  const mutationAppliers = new MutationApplierRegistry();
  mutationAppliers.register(
    new CampaignSyncMutationApplier(campaigns, campaignsWithoutServiceAudit),
  );
  mutationAppliers.register(
    new CampaignSettingSyncMutationApplier(campaigns, campaignsWithoutServiceAudit),
  );
  // Feature 16 task 06: entity and personal-note writes (re-decided, versioned, held, audited).
  const longTextHolds = new LongTextHoldService(
    new PostgresLongTextHoldRepository(syncConnection.db),
  );
  const entityService = new EntityService({
    entities,
    decider: authorization,
    members: {
      isMember: async (campaignId, userId) =>
        (await syncAccess.resolve(userId, campaignId)) !== undefined,
    },
  });
  mutationAppliers.register(
    new EntitySyncMutationApplier(entityService, longTextHolds, visibility),
  );
  mutationAppliers.register(
    new RelationshipSyncMutationApplier(
      new RelationshipService({
        entities,
        relationships,
        decider: authorization,
        members: {
          isMember: async (campaignId, userId) =>
            (await syncAccess.resolve(userId, campaignId)) !== undefined,
        },
      }),
    ),
  );
  mutationAppliers.register(
    new PersonalNoteSyncMutationApplier(
      new PersonalNoteService({ notes: personalNotes, decider: authorization }),
      longTextHolds,
    ),
  );
  // Feature 09: recorded rolls (immutable, re-decided, replayed; not audit events).
  mutationAppliers.register(
    new DiceRollSyncMutationApplier(new RollService({ rolls, decider: authorization })),
  );
  // Feature 15: characters, created and deleted here; every edit is a feature 11 application.
  const characterAudit = {
    recordWithin: (
      executor: Parameters<typeof durableAudit.recorder.recordWithin>[0],
      submission: Parameters<typeof durableAudit.recorder.recordWithin>[1],
    ) => durableAudit.recorder.recordWithin(executor, submission),
  };
  mutationAppliers.register(
    new CharacterSyncMutationApplier(
      new CharacterService({
        characters: characterRecords,
        decider: authorization,
        systems: (ref) => systemRegistry.resolve(ref),
        pin: async (actor) => {
          const viewed = await campaigns.get(actor.userId, actor.campaignId);
          return viewed.ok ? viewed.value.system : undefined;
        },
        audit: characterAudit,
      }),
    ),
  );
  // Feature 18: sessions, GM notes, and log entries, one applier per table; the service audits itself.
  const sessionService = new SessionService({
    sessions: sessionRecords,
    decider: authorization,
    audit: {
      recordWithin: (executor, submission) =>
        durableAudit.recorder.recordWithin(
          executor as Parameters<typeof durableAudit.recorder.recordWithin>[0],
          submission,
        ),
    },
  });
  for (const table of [
    SESSION_REPLICA_TABLE,
    SESSION_NOTE_REPLICA_TABLE,
    SESSION_LOG_REPLICA_TABLE,
  ] as const) {
    mutationAppliers.register(new SessionSyncMutationApplier(table, sessionService));
  }
  // Feature 19: encounters, GM notes, and participants; instance states change through feature 11 only.
  const pinnedSystem = async (campaignId: string) => {
    const campaign = await repository.get(campaignId);
    return campaign === undefined ? undefined : systemRegistry.resolve(campaign.system);
  };
  const encounterService = new EncounterService({
    encounters: encounterRecords,
    decider: authorization,
    system: pinnedSystem,
    audit: {
      recordWithin: (executor, submission) =>
        durableAudit.recorder.recordWithin(
          executor as Parameters<typeof durableAudit.recorder.recordWithin>[0],
          submission,
        ),
    },
  });
  for (const table of [
    ENCOUNTER_REPLICA_TABLE,
    ENCOUNTER_NOTE_REPLICA_TABLE,
    PARTICIPANT_REPLICA_TABLE,
  ] as const) {
    mutationAppliers.register(new EncounterSyncMutationApplier(table, encounterService));
  }
  // Feature 14: a member's section marks (bookmark, last view), merged by the authority, never audited.
  mutationAppliers.register(
    new RulesMarkSyncMutationApplier(
      new RulesMarkService({ marks: rulesMarks, decider: authorization, system: pinnedSystem }),
    ),
  );
  const participantTarget = encounterParticipantTargetAdapter({
    encounters: encounterRecords,
    system: pinnedSystem,
  });
  const characterTarget = characterTargetAdapter({
    characters: characterRecords,
    systems: (ref) => systemRegistry.resolve(ref),
    decider: authorization,
  });
  // Feature 11: effect applications (one transaction with the target and the audit event).
  mutationAppliers.register(
    new EffectApplicationSyncMutationApplier(
      new EffectApplicationService({
        applications: effectApplications,
        decider: authorization,
        targets: [characterTarget, participantTarget, ...(input.effectTargets ?? [])],
        audit: {
          recordWithin: (executor, submission) =>
            durableAudit.recorder.recordWithin(executor, submission),
        },
      }),
    ),
  );
  const syncMutations = new AuthorityMutationService(
    syncAccess,
    mutationAppliers,
    new PostgresMutationReceiptStore(syncConnection.db),
    input.integrations?.audit === undefined
      ? mutationAuditParticipantFor(durableAudit.recorder)
      : recordOnlyMutationAuditParticipant(input.integrations.audit),
  );
  const syncBootstrap = new SyncBootstrapService(
    syncAccess,
    input.powerSyncEndpoint,
    new HmacSyncTokenIssuer(input.powerSyncJwtSecret),
    undefined,
    undefined,
    revocationDelivery.subscriptions,
  );

  const attachmentRepository = new PostgresAttachmentRepository(attachmentConnection.db);
  const objectStorage = input.attachments?.storage ?? new UnconfiguredObjectStorage();
  const attachments = new AttachmentService({
    repository: attachmentRepository,
    storage: objectStorage,
    authorizer: contentAccessAttachmentAuthorizer(contentAccess, authorization),
    members: identity.memberships,
    audit: durableAudit.recorder,
    // No production content class exists yet; feature 16 adds its entity classes here.
    ownerClasses: input.attachments?.ownerClasses ?? [],
    // Operation name only: never a key, URL, filename or credential.
    log: {
      storageUnavailable: (operation) => app.log.warn({ operation }, 'object storage unavailable'),
    },
  });
  const stopAttachmentCleanup = new AttachmentCleanup({
    repository: attachmentRepository,
    storage: objectStorage,
  }).startLoop(input.attachments?.cleanupIntervalMs, (outcome) => {
    if (outcome === 'failed' || outcome.storageFailures > 0) {
      app.log.warn({ outcome }, 'attachment cleanup incomplete; retried next pass');
    }
  });
  // Feature 07 task 04: online export jobs. Job rows are safe metadata; package bytes stay in a
  // short-lived in-process store scoped to the requesting user.
  const exportJobs = new PostgresExportJobRepository(portabilityConnection.db);
  const onlineExport = createOnlineExport({
    campaigns: repository,
    attachments: attachmentRepository,
    // Feature 16 tasks 15/17: entities and relationships (never personal notes), restored on the
    // import transaction through feature 16's own writer.
    content: new ContentExporter(
      { entities, relationships },
      {
        writer: new PostgresContentImportWriter({ entities, relationships }),
        unwrap: importTransactionHandle,
      },
    ),
    // Feature 09: roll history, restored on the import transaction through its own writer.
    rolls: new RollExporter(rolls, {
      writer: new PostgresDiceImportWriter(rolls),
      unwrap: importTransactionHandle,
    }),
    // Feature 15: characters with their GM-only half, restored to the importer.
    characters: new CharacterExporter(characterRecords, {
      writer: new PostgresCharacterImportWriter(characterRecords),
      unwrap: importTransactionHandle,
    }),
    // Feature 18: sessions with their GM notes and log entries, restored to the importer.
    sessions: new SessionExporter(sessionRecords, {
      writer: new PostgresSessionImportWriter(sessionRecords),
      unwrap: importTransactionHandle,
    }),
    // Feature 19: encounters with their GM notes, participants, and instance states.
    encounters: new EncounterExporter(encounterRecords, {
      writer: new PostgresEncounterImportWriter(encounterRecords),
      unwrap: importTransactionHandle,
    }),
    jobs: exportJobs,
    applicationVersion: input.version ?? '0.0.0',
    preserved: new PostgresPreservedChunkSource(portabilityConnection.db),
    // Feature 07 task 06: feature 02 restores the campaign root (and feature 01 its sole owner)
    // on the import transaction, resolved from its opaque capability only here.
    campaignImporter: new CampaignImporter({
      catalog,
      settings,
      writer: repository,
      ownerWriter: identity.membershipWriter,
      unwrap: importTransactionHandle,
    }),
    // Code and module id only: never payload, path or package content.
    log: {
      exportFailed: (code, moduleId) => app.log.warn({ code, moduleId }, 'campaign export failed'),
    },
  });
  const importJobs = new PostgresImportJobRepository(portabilityConnection.db);
  const campaignImport = createCampaignImport({
    registry: onlineExport.registry,
    catalog,
    jobs: importJobs,
    transactions: new PostgresImportTransactions(portabilityConnection.db),
    store: new PostgresImportCommitStore(),
    committed: ({ campaignId, userId }) => campaigns.recordImported(userId, campaignId),
    // Code and module id only: never payload, path or package content.
    log: {
      importFailed: (code, moduleId) => app.log.warn({ code, moduleId }, 'campaign import failed'),
    },
  });
  const stopExportFileSweep = onlineExport.files.startSweeping();
  const stopImportRetention = startExportJobRetention(
    importJobs,
    input.exportRetentionIntervalMs ?? 3_600_000,
    (outcome) => {
      if (outcome === 'failed') app.log.warn('import job retention pass failed; retried next pass');
      else if (outcome > 0) app.log.info({ deleted: outcome }, 'import job retention');
    },
  );
  const stopExportRetention = startExportJobRetention(
    exportJobs,
    input.exportRetentionIntervalMs ?? 3_600_000,
    (outcome) => {
      if (outcome === 'failed') app.log.warn('export job retention pass failed; retried next pass');
      else if (outcome > 0) app.log.info({ deleted: outcome }, 'export job retention');
    },
  );
  // Feature 05 task 06: deleted-campaign cascade and 30-day purge. Counts only are logged.
  // Attachments of a campaign with a requested or running export are retained (feature 07);
  // attachment metadata is not replicated, so the watermark gate is vacuous today.
  const stopAttachmentReconciliation = new AttachmentReconciler({
    repository: attachmentRepository,
    storage: objectStorage,
    campaigns: {
      isDeleted: async (campaignId) => {
        const campaign = await repository.get(campaignId);
        return campaign === undefined || campaign.deletedAt !== undefined;
      },
    },
    references: exportJobAttachmentReferences(exportJobs),
  }).startLoop(input.attachments?.cleanupIntervalMs, (outcome) => {
    if (outcome === 'failed' || outcome.storageFailures > 0) {
      app.log.warn({ outcome }, 'attachment reconciliation incomplete; retried next pass');
    } else if (outcome.purged > 0 || outcome.tombstoned > 0) {
      app.log.info({ outcome }, 'attachment reconciliation');
    }
  });

  registerIdentityAuthentication(app, identity.accounts);
  // Before any content route: the inventory fails startup for a content route without the helper.
  contentAccess.install(app);
  registerIdentityRoutes(app, identity, {
    allowedOrigin: input.allowedOrigin,
    secureCookies: input.production,
  });
  registerVisibilityRoutes(
    app,
    { access: contentAccess, visibility },
    { allowedOrigin: input.allowedOrigin },
  );
  registerCampaignRoutes(
    app,
    { campaigns, systems: catalog },
    { allowedOrigin: input.allowedOrigin },
  );
  // Feature 16 task 07: read-only content routes (writes are sync mutations only).
  registerContentRoutes(app, {
    access: contentAccess,
    entities,
    notes: personalNotes,
    relationships,
  });
  registerAttachmentRoutes(
    app,
    { attachments, access: contentAccess },
    { allowedOrigin: input.allowedOrigin },
  );
  registerPortabilityRoutes(
    app,
    {
      exports: onlineExport.service,
      imports: campaignImport,
      access: contentAccess,
      // Display identity only (feature 01: never email or credentials).
      displayName: async (userId) =>
        (await identity.memberships.listUser(userId, { limit: 1 })).items[0]?.user.username ??
        'Game master',
    },
    { allowedOrigin: input.allowedOrigin },
  );
  // Membership history facts are for audit reads only; ContentAccess never addresses the class.
  const auditTargets = new AuditTargetAccess({
    registry: policies,
    sources: [...factsSources, membershipFactsSource(identity.memberships)],
  });
  registerAuditRoutes(app, {
    access: contentAccess,
    targets: auditTargets,
    queries: durableAudit.queries,
  });
  // Feature 06 retention: off unless explicitly enabled; counts and safe codes only are logged.
  const stopAuditRetention = startAuditRetention(
    createAuditRetention({
      auditDb: durableAudit.db,
      syncDb: syncConnection.db,
      eligibility: auditReplicaEligibility({ actors: syncAccess, targets: auditTargets }),
    }).executor,
    { ...input.auditRetention, delete: input.auditRetention?.delete === true },
    (outcome) => {
      if (outcome === 'failed') app.log.warn('audit retention pass failed; retried next pass');
      else
        app.log.info({ deleted: outcome.deleted, truncated: outcome.truncated }, 'audit retention');
    },
  );
  registerSyncRoutes(
    app,
    {
      access: syncAccess,
      bootstrap: syncBootstrap,
      mutations: syncMutations,
      holds: longTextHolds,
      records: contentAccess,
      watermarks: new PostgresWatermarkStore(syncConnection.db),
      auditAcknowledgements: auditAcknowledgementsFor({
        targets: auditTargets,
        resolvers: durableAudit.acknowledgements,
      }),
    },
    { allowedOrigin: input.allowedOrigin },
  );

  app.addHook('onClose', async () => {
    stopDenialReport();
    stopAuditRetry();
    stopAuditRetention();
    stopRevocationRetry();
    stopAttachmentCleanup();
    stopAttachmentReconciliation();
    stopExportFileSweep();
    stopExportRetention();
    stopImportRetention();
    await durableAudit.close();
    await identity.close();
    await campaignConnection.close();
    await syncConnection.close();
    await attachmentConnection.close();
    await portabilityConnection.close();
    await contentConnection.close();
    await diceConnection.close();
    await actionsConnection.close();
    await charactersConnection.close();
    await sessionsConnection.close();
    await encountersConnection.close();
    await rulesConnection.close();
  });
  return app;
}
