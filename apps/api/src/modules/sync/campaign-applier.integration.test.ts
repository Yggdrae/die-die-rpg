import { afterAll, describe, expect, test } from 'bun:test';
import {
  AccountAuditRepository,
  type AuditFailureSignal,
  AuditRendererRegistry,
  type AuditRepairOutbox,
  CampaignAuditRepository,
  connectAuditDatabase,
  DurableAuditRecorder,
  PostgresAuditRepairOutbox,
  PrivateAuditRepository,
} from '@rpg/audit';
import {
  CAMPAIGN_REPLICA_TABLE,
  CAMPAIGN_SETTING_REPLICA_TABLE,
  CAMPAIGN_SYNC_FEATURE_ID,
  type CampaignDetailsUpdateInput,
  CampaignService,
  CampaignSettingRegistry,
  type CampaignTransactionParticipant,
  connectCampaignDatabase,
  PostgresCampaignRepository,
  StaticSystemCatalog,
} from '@rpg/campaigns';
import { type AuditEvent, type AuditRecorder, err, ok } from '@rpg/contracts';
import { FIXTURE_SYSTEM_DEFINITION } from '@rpg/fixtures';
import { PostgresCampaignMembershipWriter } from '@rpg/identity';
import {
  AuthorityMutationService,
  MutationApplierRegistry,
  type MutationAuditParticipant,
  type PendingMutation,
} from '@rpg/sync';
import { connectSyncDatabase, PostgresMutationReceiptStore } from '@rpg/sync/postgres';
import { Type } from '@sinclair/typebox';
import postgres from 'postgres';
import { mutationAuditParticipantFor } from '../audit/composition.ts';
import {
  CampaignSettingSyncMutationApplier,
  CampaignSyncMutationApplier,
} from './campaign-applier.ts';

/**
 * Feature 06 task 02, `_db.md` Write Path on PostgreSQL: an uploaded campaign mutation, its
 * single routed audit insert (or repair-outbox entry), and the domain write share one
 * transaction. Real campaign, audit, and receipt stores; failures are injected inside that
 * transaction. Skipped when no migrated database is reachable.
 */

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const sql =
  databaseUrl === undefined
    ? undefined
    : postgres(databaseUrl, { max: 2, onnotice: () => undefined });
const available = await (async () => {
  if (sql === undefined) return false;
  try {
    await sql`select 1 from audit_campaign_events, audit_repair_outbox, campaigns,
      sync_mutation_receipts limit 1`;
    return true;
  } catch {
    return false;
  }
})();
const connections =
  available && databaseUrl !== undefined
    ? {
        campaigns: connectCampaignDatabase(databaseUrl),
        sync: connectSyncDatabase(databaseUrl),
        audit: connectAuditDatabase(databaseUrl, { max: 2 }),
      }
    : undefined;
afterAll(async () => {
  await connections?.campaigns.close();
  await connections?.sync.close();
  await connections?.audit.close();
  await sql?.end({ timeout: 1 });
});

const SECRET = 'hidden-gm-note';
const NAMESPACE = 'feature.weather';

describe.skipIf(!available)(
  'campaign mutation audit in the domain transaction (PostgreSQL)',
  () => {
    function harness(
      options: {
        /** The routed audit insert fails inside the domain transaction (savepoint rolled back). */
        readonly appendWithinFails?: boolean;
        /** The in-transaction repair-outbox entry fails too. */
        readonly parkWithinFails?: boolean;
      } = {},
    ) {
      if (connections === undefined) throw new Error('database unavailable');
      const auditDb = connections.audit.db;
      const signals: AuditFailureSignal[] = [];
      const record = (signal: Partial<AuditFailureSignal>) =>
        signals.push(signal as AuditFailureSignal);
      const realCampaignStore = new CampaignAuditRepository(auditDb);
      const realOutbox = new PostgresAuditRepairOutbox(auditDb);
      const parked = new Set<string>();
      const outbox: AuditRepairOutbox = {
        park: (input) => realOutbox.park(input),
        parkWithin: (executor, input) => {
          parked.add(input.envelope.eventId);
          return options.parkWithinFails === true
            ? executor.transaction(async () => {
                throw new Error('repair outbox unavailable');
              })
            : realOutbox.parkWithin(executor, input);
        },
        // Scoped to this harness: the shared database holds other tests' pending entries.
        due: async (now, limit) =>
          (await realOutbox.due(now, 1_000))
            .filter((entry) => parked.has(entry.envelope.eventId))
            .slice(0, limit),
        resolve: (eventId) => realOutbox.resolve(eventId),
        backlog: () => realOutbox.backlog(),
      };
      const recorder = new DurableAuditRecorder({
        campaign: {
          append: (envelope) => realCampaignStore.append(envelope),
          appendWithin: (executor, envelope) =>
            options.appendWithinFails === true
              ? executor.transaction(async () => {
                  throw new Error('audit store unavailable');
                })
              : realCampaignStore.appendWithin(executor, envelope),
        },
        private: new PrivateAuditRepository(auditDb),
        account: new AccountAuditRepository(auditDb),
        outbox,
        registry: new AuditRendererRegistry(),
        diagnostics: { degraded: record, deadLettered: record, repaired: record },
        options: { baseDelayMs: 0 },
      });
      const adapter = mutationAuditParticipantFor(recorder);
      const within: boolean[] = [];
      const afterCommit: string[] = [];
      const participant: MutationAuditParticipant = {
        recordMutationOutcome: async (input) => {
          afterCommit.push(input.outcome.status);
          await adapter.recordMutationOutcome(input);
        },
        recordAcceptedWithin: async (transaction, input) => {
          const held = (await adapter.recordAcceptedWithin?.(transaction, input)) === true;
          within.push(held);
          return held;
        },
      };

      // A domain failure that happens after the audit insert, inside the same transaction.
      let failAfterAudit = false;
      class FailingAfterAuditRepository extends PostgresCampaignRepository {
        override updateDetails(
          campaignId: string,
          input: CampaignDetailsUpdateInput,
          actorUserId: string,
          withinTransaction?: CampaignTransactionParticipant,
        ) {
          return super.updateDetails(
            campaignId,
            input,
            actorUserId,
            withinTransaction === undefined
              ? undefined
              : async (transaction) => {
                  await withinTransaction(transaction);
                  if (failAfterAudit) {
                    failAfterAudit = false;
                    throw new Error('domain failure after the audit insert');
                  }
                },
          );
        }
      }
      const repository = new FailingAfterAuditRepository(connections.campaigns.db);
      const ownerOf = async (userId: string, campaignId: string) => {
        const campaign = await repository.get(campaignId);
        return campaign !== undefined &&
          campaign.deletedAt === undefined &&
          campaign.createdBy === userId
          ? { userId, campaignId, role: 'owner' as const }
          : undefined;
      };
      const settings = new CampaignSettingRegistry();
      settings.register({
        namespace: NAMESPACE,
        schema: Type.Object({ enabled: Type.Boolean() }, { additionalProperties: false }),
        memberVisible: true,
        writableRoles: ['owner'],
      });
      const serviceEvents: Omit<AuditEvent, 'id'>[] = [];
      const service = (recorderPort: AuditRecorder) =>
        new CampaignService(
          repository,
          new StaticSystemCatalog([FIXTURE_SYSTEM_DEFINITION]),
          {
            resolve: async (userId, campaignId) => {
              const actor = await ownerOf(userId, campaignId);
              return actor === undefined ? err('membership_not_found') : ok(actor);
            },
            listCampaignIds: async () => [],
          },
          new PostgresCampaignMembershipWriter(),
          { decide: (actor) => actor.role === 'owner' },
          settings,
          recorderPort,
          { auditDegraded: () => undefined },
        );
      const audited = service({ record: async (event) => void serviceEvents.push(event) });
      const unaudited = service({ record: async () => undefined });
      const appliers = new MutationApplierRegistry();
      appliers.register(new CampaignSyncMutationApplier(audited, unaudited));
      appliers.register(new CampaignSettingSyncMutationApplier(audited, unaudited));
      let accessLost = false;
      const authority = new AuthorityMutationService(
        {
          resolve: ownerOf,
          resolveWithin: async (_transaction, userId, campaignId) =>
            accessLost ? undefined : { userId, campaignId, role: 'owner' as const },
        },
        appliers,
        new PostgresMutationReceiptStore(connections.sync.db),
        participant,
      );
      return {
        recorder,
        unaudited,
        signals,
        within,
        afterCommit,
        serviceEvents,
        failNextAfterAudit: () => {
          failAfterAudit = true;
        },
        /** The in-transaction membership read finds a revocation the first resolve did not. */
        loseAccessDuringWrites: () => {
          accessLost = true;
        },
        upload: async (userId: string, campaignId: string, ...mutations: PendingMutation[]) =>
          (
            await authority.apply(userId, { campaignId, replicaId: crypto.randomUUID(), mutations })
          ).map((outcome) => outcome.status),
        uploadOutcomes: (userId: string, campaignId: string, ...mutations: PendingMutation[]) =>
          authority.apply(userId, { campaignId, replicaId: crypto.randomUUID(), mutations }),
      };
    }

    async function insertUser(): Promise<string> {
      if (sql === undefined) throw new Error('database unavailable');
      const userId = crypto.randomUUID();
      const handle = userId.slice(0, 8);
      await sql`insert into identity_users
        (id, username_display, username_normalized, created_at, updated_at)
      values (${userId}, ${`Audit_${handle}`}, ${`audit_${handle}`}, now(), now())`;
      return userId;
    }

    async function createCampaign(
      server: ReturnType<typeof harness>,
      userId: string,
    ): Promise<string> {
      const id = crypto.randomUUID();
      const created = await server.unaudited.create(userId, {
        id,
        system: FIXTURE_SYSTEM_DEFINITION.summary.ref,
        gameMode: 'standard',
        options: {},
        moduleIds: [],
        name: 'Atomic Road',
        description: '',
      });
      expect(created.ok).toBe(true);
      return id;
    }

    function envelope(campaignId: string, action: string) {
      return {
        campaignId,
        action,
        targetType: CAMPAIGN_REPLICA_TABLE,
        targetId: campaignId,
        after: { note: SECRET },
        at: '2026-10-26T12:00:00Z',
        private: false,
      };
    }

    function mutation(
      campaignId: string,
      overrides: Partial<PendingMutation> & Pick<PendingMutation, 'operation'>,
    ): PendingMutation {
      return {
        mutationId: crypto.randomUUID(),
        campaignId,
        featureId: CAMPAIGN_SYNC_FEATURE_ID,
        tableName: CAMPAIGN_REPLICA_TABLE,
        recordId: campaignId,
        expectedVersion: null,
        payload: {},
        audit: envelope(campaignId, `campaigns.${overrides.operation}`),
        causalSequence: 1,
        state: 'pending',
        attemptCount: 1,
        recordedAt: '2026-10-26T12:00:00Z',
        ...overrides,
      };
    }

    const rename = (campaignId: string, expectedVersion: number, name: string) =>
      mutation(campaignId, {
        operation: 'update',
        expectedVersion,
        payload: { name, description: 'Edited offline.' },
      });

    async function eventsFor(campaignId: string) {
      if (sql === undefined) throw new Error('database unavailable');
      return [
        ...(await sql<{ origin: string; action: string; actor: string; role: string }[]>`
        select origin_mutation_id as origin, action, actor_user_id as actor, actor_role as role
        from audit_campaign_events where campaign_id = ${campaignId}
        order by campaign_sequence`),
      ];
    }

    async function outboxFor(originMutationId: string) {
      if (sql === undefined) throw new Error('database unavailable');
      return [
        ...(await sql<{ state: string; code: string }[]>`
        select state, failure_code as code from audit_repair_outbox
        where origin_mutation_id = ${originMutationId}`),
      ];
    }

    async function campaignRow(campaignId: string) {
      if (sql === undefined) throw new Error('database unavailable');
      const [row] = await sql<{ name: string; version: number }[]>`
      select name, version::int as version from campaigns where id = ${campaignId}`;
      return row;
    }

    async function receiptCount(mutationId: string): Promise<number> {
      if (sql === undefined) throw new Error('database unavailable');
      const [row] = await sql<{ n: number }[]>`
      select count(*)::int as n from sync_mutation_receipts where mutation_id = ${mutationId}`;
      return row?.n ?? -1;
    }

    test('A significant mutation records one event: create, edit, setting, and delete commit with their event', async () => {
      const server = harness();
      const userId = await insertUser();
      const campaignId = crypto.randomUUID();
      const now = '2026-10-26T12:00:00.000Z';
      const entity = {
        campaignId,
        tags: [],
        metadata: {},
        visibility: { mode: 'everyone' as const },
        version: 1,
        createdAt: now,
        createdBy: userId,
        updatedAt: now,
        updatedBy: userId,
      };
      const create = mutation(campaignId, {
        operation: 'insert',
        payload: {
          ...entity,
          id: campaignId,
          type: 'campaign',
          name: 'Offline Atomic',
          description: '',
          system: FIXTURE_SYSTEM_DEFINITION.summary.ref,
          gameMode: 'standard',
          modulePins: [],
          settings: {},
          causalGroupId: crypto.randomUUID(),
          invitationIntents: [],
        },
      });
      const edit = { ...rename(campaignId, 1, 'Renamed Atomic'), causalSequence: 2 };
      const settingId = crypto.randomUUID();
      const setting = mutation(campaignId, {
        tableName: CAMPAIGN_SETTING_REPLICA_TABLE,
        recordId: settingId,
        operation: 'insert',
        causalSequence: 3,
        payload: {
          ...entity,
          id: settingId,
          type: 'campaign_setting',
          name: NAMESPACE,
          namespace: NAMESPACE,
          value: { enabled: true },
          memberVisible: true,
        },
      });
      // Creation is authorized through creation scope: no membership exists before it commits.
      expect(await server.upload(userId, campaignId, create, edit, setting)).toEqual([
        'accepted',
        'accepted',
        'accepted',
      ]);
      // Retrying an event does not duplicate it: the replay repairs idempotently.
      expect(await server.upload(userId, campaignId, edit)).toEqual(['accepted']);
      expect(server.afterCommit).toEqual(['accepted']);
      const remove = mutation(campaignId, { operation: 'tombstone', expectedVersion: 3 });
      expect(await server.upload(userId, campaignId, remove)).toEqual(['accepted']);

      expect(await eventsFor(campaignId)).toEqual(
        [create, edit, setting, remove].map((item) => ({
          origin: item.mutationId,
          action: item.audit?.action ?? 'missing',
          actor: userId,
          role: 'owner',
        })),
      );
      expect(await campaignRow(campaignId)).toEqual({ name: 'Renamed Atomic', version: 4 });
      // Every event was held by its domain transaction; only the replay used the after-commit path.
      expect(server.within).toEqual([true, true, true, true]);
      expect(server.afterCommit).toEqual(['accepted']);
      expect(server.serviceEvents).toEqual([]);
      for (const item of [create, edit, setting, remove]) {
        expect(await outboxFor(item.mutationId)).toEqual([]);
      }
    });

    test('access lost during the write: edit, setting, and delete all roll back as denied', async () => {
      const server = harness();
      const userId = await insertUser();
      const campaignId = await createCampaign(server, userId);
      const before = await campaignRow(campaignId);
      const version = before?.version ?? 0;
      server.loseAccessDuringWrites();

      const settingId = crypto.randomUUID();
      const attempts = [
        rename(campaignId, version, 'Written after revocation'),
        mutation(campaignId, {
          tableName: CAMPAIGN_SETTING_REPLICA_TABLE,
          recordId: settingId,
          operation: 'insert',
          payload: {
            id: settingId,
            campaignId,
            tags: [],
            metadata: {},
            visibility: { mode: 'everyone' },
            version: 1,
            createdAt: '2026-10-26T12:00:00.000Z',
            createdBy: userId,
            updatedAt: '2026-10-26T12:00:00.000Z',
            updatedBy: userId,
            type: 'campaign_setting',
            name: NAMESPACE,
            namespace: NAMESPACE,
            value: { enabled: true },
            memberVisible: true,
          },
        }),
        mutation(campaignId, { operation: 'tombstone', expectedVersion: version }),
      ];
      for (const attempt of attempts) {
        expect(await server.uploadOutcomes(userId, campaignId, attempt)).toEqual([
          {
            mutationId: attempt.mutationId,
            status: 'error',
            code: 'not_found_or_forbidden',
            retryable: false,
          },
        ]);
      }
      expect(await campaignRow(campaignId)).toEqual(before);
      expect(await eventsFor(campaignId)).toEqual([]);
      if (sql === undefined) throw new Error('database unavailable');
      const [deleted] = await sql<{ deleted: boolean }[]>`
        select deleted_at is not null as deleted from campaigns where id = ${campaignId}`;
      expect(deleted?.deleted).toBe(false);
      const settings = await sql`
        select 1 from campaign_settings
        where campaign_id = ${campaignId} and namespace = ${NAMESPACE}`;
      expect(settings).toHaveLength(0);
    });

    test('a domain failure after the audit insert rolls back both; the retry records exactly one event', async () => {
      const server = harness();
      const userId = await insertUser();
      const campaignId = await createCampaign(server, userId);
      const edit = rename(campaignId, 1, 'Never Committed');

      server.failNextAfterAudit();
      const [failed] = await server.uploadOutcomes(userId, campaignId, edit);
      expect(failed).toMatchObject({
        status: 'error',
        code: 'authority_unavailable',
        retryable: true,
      });
      // The audit insert ran inside the transaction and rolled back with the write.
      expect(server.within).toEqual([true]);
      expect(await campaignRow(campaignId)).toEqual({ name: 'Atomic Road', version: 1 });
      expect(await eventsFor(campaignId)).toEqual([]);
      expect(await outboxFor(edit.mutationId)).toEqual([]);
      expect(await receiptCount(edit.mutationId)).toBe(0);
      expect(server.afterCommit).toEqual([]);

      // Same mutation ID retried, then replayed: one write, one event.
      expect(await server.upload(userId, campaignId, edit)).toEqual(['accepted']);
      expect(await server.upload(userId, campaignId, edit)).toEqual(['accepted']);
      expect(await campaignRow(campaignId)).toEqual({ name: 'Never Committed', version: 2 });
      expect((await eventsFor(campaignId)).map((row) => row.origin)).toEqual([edit.mutationId]);
      expect(await receiptCount(edit.mutationId)).toBe(1);
    });

    test('Audit failure does not reject play: an insert failure parks the event in the outbox within the write', async () => {
      const server = harness({ appendWithinFails: true });
      const userId = await insertUser();
      const campaignId = await createCampaign(server, userId);
      const edit = rename(campaignId, 1, 'Played On');

      expect(await server.upload(userId, campaignId, edit)).toEqual(['accepted']);
      expect(await campaignRow(campaignId)).toEqual({ name: 'Played On', version: 2 });
      expect(await eventsFor(campaignId)).toEqual([]);
      // Retained for retry, committed in the same transaction as the write.
      expect(await outboxFor(edit.mutationId)).toEqual([
        { state: 'pending', code: 'store_unavailable' },
      ]);
      expect(server.within).toEqual([true]);
      expect(server.afterCommit).toEqual([]);
      expect(server.signals.map((signal) => [signal.code, signal.parkedIn])).toEqual([
        ['store_unavailable', 'outbox'],
      ]);
      expect(JSON.stringify(server.signals)).not.toContain(SECRET);

      // The retry loop repairs it once; a later replay of the mutation adds nothing.
      const report = await server.recorder.retryPending();
      expect(report).toMatchObject({ repaired: 1, deferred: 0, deadLettered: 0 });
      expect(await server.upload(userId, campaignId, edit)).toEqual(['accepted']);
      expect((await eventsFor(campaignId)).map((row) => row.origin)).toEqual([edit.mutationId]);
      expect(await outboxFor(edit.mutationId)).toEqual([
        { state: 'repaired', code: 'store_unavailable' },
      ]);
    });

    test('when the transaction cannot hold the event at all, it is recorded once after commit', async () => {
      const server = harness({ appendWithinFails: true, parkWithinFails: true });
      const userId = await insertUser();
      const campaignId = await createCampaign(server, userId);
      const edit = rename(campaignId, 1, 'Recorded Later');

      expect(await server.upload(userId, campaignId, edit)).toEqual(['accepted']);
      expect(await campaignRow(campaignId)).toEqual({ name: 'Recorded Later', version: 2 });
      // The in-transaction gap is visible, then closed after commit, when the outcome is known.
      expect(server.within).toEqual([false]);
      expect(server.afterCommit).toEqual(['accepted']);
      expect(server.signals.map((signal) => [signal.code, signal.parkedIn])).toEqual([
        ['store_unavailable', 'none'],
      ]);
      expect((await eventsFor(campaignId)).map((row) => row.origin)).toEqual([edit.mutationId]);
      expect(await outboxFor(edit.mutationId)).toEqual([]);
    });

    test('A rejected offline mutation does not become accepted history', async () => {
      const server = harness();
      const userId = await insertUser();
      const outsider = await insertUser();
      const campaignId = await createCampaign(server, userId);
      const stale = rename(campaignId, 7, 'Stale');
      const invalid = mutation(campaignId, {
        operation: 'update',
        expectedVersion: 1,
        payload: {},
      });
      const foreign = rename(campaignId, 1, 'Not Mine');

      expect(await server.upload(userId, campaignId, stale)).toEqual(['conflict']);
      expect(await server.upload(userId, campaignId, invalid)).toEqual(['error']);
      expect(await server.upload(outsider, campaignId, foreign)).toEqual(['error']);
      expect(await campaignRow(campaignId)).toEqual({ name: 'Atomic Road', version: 1 });
      expect(await eventsFor(campaignId)).toEqual([]);
      for (const item of [stale, invalid, foreign]) {
        expect(await outboxFor(item.mutationId)).toEqual([]);
      }
      expect(server.within).toEqual([]);
      // Correlated outcomes still reach the participant, which stores no history for them.
      expect(server.afterCommit).toEqual(['conflict', 'error']);
    });
  },
);
