import {
  type AuditDatabase,
  type AuditRetentionReport,
  type AuditRetentionRunOptions,
  connectAuditDatabase,
  PostgresAuditRetentionExecutor,
  PostgresAuditRetentionReporter,
} from '@rpg/audit';
import { ResourcePolicyRegistry } from '@rpg/authorization';
import { connectCampaignDatabase, PostgresCampaignRepository } from '@rpg/campaigns';
import { createPostgresIdentityRuntime } from '@rpg/identity';
import type { ReplicaScopeEligibility } from '@rpg/sync';
import {
  connectSyncDatabase,
  PostgresTombstonePurgeEvidence,
  PostgresWatermarkStore,
  type SyncDatabase,
} from '@rpg/sync/postgres';
import { campaignFactsSource } from '../campaigns/facts.ts';
import { registerResourcePolicies } from '../sync/sync-rules.ts';
import { auditReplicaEligibility } from './replica-acknowledgement.ts';
import { AuditTargetAccess } from './target-access.ts';

/**
 * Feature 06 retention composition (365 days, Approved 2026-10-28, delegated by owner).
 *
 * The watermark evidence is feature 03's, narrowed by audit store eligibility. Deletion is OFF
 * by default everywhere: the runtime starts no loop and the CLI only reports unless an operator
 * sets `AUDIT_RETENTION_DELETE=true` (the exact string).
 */
export function createAuditRetention(deps: {
  readonly auditDb: AuditDatabase;
  readonly syncDb: SyncDatabase;
  readonly eligibility: ReplicaScopeEligibility;
}): {
  readonly reporter: PostgresAuditRetentionReporter;
  readonly executor: PostgresAuditRetentionExecutor;
} {
  const evidence = new PostgresTombstonePurgeEvidence(
    deps.syncDb,
    new PostgresWatermarkStore(deps.syncDb),
    deps.eligibility,
  );
  const reporter = new PostgresAuditRetentionReporter(deps.auditDb, evidence);
  return { reporter, executor: new PostgresAuditRetentionExecutor(deps.auditDb, reporter) };
}

/**
 * Stand-alone composition for the operator CLI (and its tests): its own small pools, the same
 * feature 04 decision and feature 01 `ActorResolver` as the API. Only `memberships.resolve` of
 * the identity runtime is used; its write-side ports are inert.
 */
export function connectAuditRetention(databaseUrl: string) {
  const audit = connectAuditDatabase(databaseUrl, { max: 1 });
  const sync = connectSyncDatabase(databaseUrl);
  const campaigns = connectCampaignDatabase(databaseUrl);
  const identity = createPostgresIdentityRuntime({
    connectionString: databaseUrl,
    campaignNames: { getDisplayName: async () => undefined },
    audit: { record: async () => undefined },
    revocations: { publish: async () => undefined },
    recoveryAudit: { recordIssued: async () => undefined },
    authenticationLog: {
      accountCreated: () => undefined,
      loginSucceeded: () => undefined,
      loginFailed: () => undefined,
      sessionRevoked: () => undefined,
    },
    recoveryLog: {
      recoveryIssued: () => undefined,
      recoveryIssuanceAuditDegraded: () => undefined,
      recoverySucceeded: () => undefined,
      recoveryFailed: () => undefined,
    },
    membershipLog: { integrationDegraded: () => undefined },
  });
  const targets = new AuditTargetAccess({
    registry: registerResourcePolicies(new ResourcePolicyRegistry()),
    sources: [campaignFactsSource(new PostgresCampaignRepository(campaigns.db))],
  });
  const retention = createAuditRetention({
    auditDb: audit.db,
    syncDb: sync.db,
    eligibility: auditReplicaEligibility({
      actors: {
        resolve: async (userId, campaignId) => {
          const actor = await identity.memberships.resolve(userId, campaignId);
          return actor.ok ? actor.value : undefined;
        },
      },
      targets,
    }),
  });
  return {
    ...retention,
    auditDb: audit.db,
    close: async () => {
      await audit.close();
      await sync.close();
      await campaigns.close();
      await identity.close();
    },
  };
}

/** Only the exact value `true` enables deletion; anything else (or unset) keeps report-only. */
export function auditRetentionDeleteFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return env.AUDIT_RETENTION_DELETE === 'true';
}

/** Default pass interval when deletion is enabled in the API process: once a day. */
export const AUDIT_RETENTION_DEFAULT_INTERVAL_MS = 86_400_000;

/**
 * Periodic deletion pass, started only when `delete` is true. A failed pass is reported and
 * retried on the next interval; it never touches campaign operations.
 */
export function startAuditRetention(
  executor: Pick<PostgresAuditRetentionExecutor, 'run'>,
  options: AuditRetentionRunOptions & { readonly intervalMs?: number },
  report: (outcome: AuditRetentionReport | 'failed') => void,
): () => void {
  if (options.delete !== true) return () => undefined;
  const { intervalMs, ...run } = options;
  let running = false;
  const pass = () => {
    if (running) return;
    running = true;
    executor
      .run(run)
      .then(report, () => report('failed'))
      .finally(() => {
        running = false;
      });
  };
  const timer = setInterval(pass, intervalMs ?? AUDIT_RETENTION_DEFAULT_INTERVAL_MS);
  (timer as { unref?: () => void }).unref?.();
  return () => clearInterval(timer);
}
