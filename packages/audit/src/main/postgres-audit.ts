import { AuditAcknowledgementResolver } from '../acknowledgement.ts';
import {
  AccountAuditRepository,
  CampaignAuditRepository,
  connectAuditDatabase,
  PostgresAuditRepairOutbox,
  PrivateAuditRepository,
} from '../infra/postgres/repositories.ts';
import type { AuditTargetDeclarations } from '../model.ts';
import { AuditQueryService } from '../query.ts';
import {
  type AuditDiagnostics,
  DurableAuditRecorder,
  type DurableAuditRecorderOptions,
} from '../recorder.ts';
import { AuditRendererRegistry } from '../renderers.ts';

/** Composition for the API and operator CLI: one small pool, durable stores, repair outbox. */
export function createPostgresAuditRuntime(input: {
  readonly connectionString: string;
  readonly diagnostics: AuditDiagnostics;
  readonly registry?: AuditRendererRegistry;
  /** Feature 04 target-class declarations (composition); absent keeps GM-only for every target. */
  readonly targets?: AuditTargetDeclarations;
  readonly options?: DurableAuditRecorderOptions;
  readonly maxConnections?: number;
}) {
  const connection = connectAuditDatabase(input.connectionString, { max: input.maxConnections });
  const registry = input.registry ?? new AuditRendererRegistry();
  const campaign = new CampaignAuditRepository(connection.db);
  const privateStore = new PrivateAuditRepository(connection.db);
  const recorder = new DurableAuditRecorder({
    campaign,
    private: privateStore,
    account: new AccountAuditRepository(connection.db),
    outbox: new PostgresAuditRepairOutbox(connection.db),
    registry,
    diagnostics: input.diagnostics,
    ...(input.targets === undefined ? {} : { targets: input.targets }),
    options: input.options,
  });
  // One query service per physical store, bound here: no request input chooses the table.
  const queries = {
    campaign: new AuditQueryService(campaign, registry),
    private: new AuditQueryService(privateStore, registry),
  } as const;
  // Replica acknowledgement (retention follow-up): same binding, one resolver per store.
  const acknowledgements = {
    campaign: new AuditAcknowledgementResolver(campaign),
    private: new AuditAcknowledgementResolver(privateStore),
  } as const;
  return {
    recorder,
    registry,
    queries,
    acknowledgements,
    db: connection.db,
    close: connection.close,
  };
}
