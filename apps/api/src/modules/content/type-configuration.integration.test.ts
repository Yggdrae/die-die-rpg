import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPostgresAuditRuntime } from '@rpg/audit';
import {
  AuthorizationService,
  ResourcePolicyRegistry,
  VisibilityService,
} from '@rpg/authorization';
import {
  CONTENT_CONFIGURATION,
  CONTENT_SYNC_FEATURE_ID,
  defineContentConfiguration,
  ENTITY_REPLICA_TABLE,
  ENTITY_TYPES,
  EntityLocalRepository,
  type EntityRecord,
  RELATIONSHIP_KINDS,
} from '@rpg/content';
import {
  connectContentDatabase,
  EntityService,
  EntityVisibilityAdapter,
  PostgresEntityRepository,
  PostgresRelationshipRepository,
  RelationshipVisibilityAdapter,
} from '@rpg/content/postgres';
import { type ActorRef, err, ok, type Role } from '@rpg/contracts';
import {
  AuthorityMutationService,
  compileProviderQueries,
  LongTextHoldService,
  MutationApplierRegistry,
  type MutationBatch,
  POSTGRES_DIALECT,
  SyncStatusStore,
} from '@rpg/sync';
import {
  ConflictHub,
  MutationQueue,
  SqliteReplicaStore,
  SqliteSyncedRepository,
} from '@rpg/sync/bun';
import {
  connectSyncDatabase,
  PostgresLongTextHoldRepository,
  PostgresMutationReceiptStore,
} from '@rpg/sync/postgres';
import postgres from 'postgres';
import { mutationAuditParticipantFor } from '../audit/composition.ts';
import { createAuditRendererRegistry } from '../audit/contributors.ts';
import { registerResourcePolicies, SYNC_RULE_BINDINGS } from '../sync/sync-rules.ts';
import { EntitySyncMutationApplier } from './appliers.ts';

/**
 * Feature 16 task 16, PRD success signal "adding a new entity type requires configuration only"
 * (BDD "A new type needs configuration only", "A type removed from configuration does not lose
 * data"). The only change is one type entry appended to the shipped list (`[...ENTITY_TYPES,
 * vehicle]`), injected where the composition root passes `CONTENT_CONFIGURATION`; every screen,
 * route, table, sync rule and policy is the production one. A `vehicle` is created offline on a
 * device, uploaded through the real authority, filtered, replicated by the compiled stream query,
 * revealed through feature 04, deleted, and survives its type's removal. Content rows are deleted
 * afterwards; audit rows, users, campaigns, and memberships stay (as in earlier suites).
 */

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const sql =
  databaseUrl === undefined
    ? undefined
    : postgres(databaseUrl, { max: 2, onnotice: () => undefined });
const db = sql as NonNullable<typeof sql>;
const available = await (async () => {
  if (sql === undefined) return false;
  try {
    await sql`select 1 from content_entities, audit_campaign_events limit 1`;
    return true;
  } catch {
    return false;
  }
})();
const seeded = { campaigns: [] as string[], files: [] as string[] };

afterAll(async () => {
  if (available) {
    const campaigns = seeded.campaigns;
    await db`delete from content_entities where campaign_id = any(${campaigns}::uuid[])`;
    await db`delete from sync_mutation_receipts where campaign_id = any(${campaigns}::uuid[])`;
  }
  await sql?.end({ timeout: 1 });
  for (const file of seeded.files) rmSync(file, { recursive: true, force: true });
});

/** The one configuration change: a type entry. Nothing else is added anywhere. */
const VEHICLE = {
  id: 'vehicle',
  label: 'Vehicle',
  pluralLabel: 'Vehicles',
  quickCreate: { secondField: 'summary' },
  enabled: true,
} as const;
const WITH_VEHICLE = defineContentConfiguration({
  types: [...ENTITY_TYPES, VEHICLE],
  kinds: RELATIONSHIP_KINDS,
});

/** A campaign with an owner and a player, as feature 01/02 store them (the provider's view). */
async function seedCampaign() {
  const [owner, player] = [crypto.randomUUID(), crypto.randomUUID()];
  for (const userId of [owner, player]) {
    const suffix = userId.replaceAll('-', '').slice(0, 12);
    await db`insert into identity_users (id, username_display, username_normalized)
      values (${userId}, ${`Tc_${suffix}`}, ${`tc_${suffix}`})`;
  }
  const campaign = crypto.randomUUID();
  seeded.campaigns.push(campaign);
  await db.begin(async (tx) => {
    await tx`insert into campaigns (id, name, game_mode, created_by)
      values (${campaign}, 'Type by configuration', 'standard', ${owner})`;
    await tx`insert into identity_campaign_memberships (campaign_id, user_id, role)
      values (${campaign}, ${owner}, 'owner'), (${campaign}, ${player}, 'player')`;
  });
  return { campaign, owner, player };
}

describe.skipIf(!available)('a new entity type needs configuration only (PostgreSQL)', () => {
  test('create offline, upload, filter, replicate, reveal, delete; removal keeps the data', async () => {
    if (databaseUrl === undefined) throw new Error('database unavailable');
    const { campaign, owner, player } = await seedCampaign();
    const roles = new Map<string, Role>([
      [owner, 'owner'],
      [player, 'player'],
    ]);
    const content = connectContentDatabase(databaseUrl, { max: 2 });
    const syncDb = connectSyncDatabase(databaseUrl);
    const audit = createPostgresAuditRuntime({
      connectionString: databaseUrl,
      diagnostics: { degraded: () => {}, deadLettered: () => {}, repaired: () => {} },
      registry: createAuditRendererRegistry(),
      maxConnections: 2,
    });
    const directory = mkdtempSync(join(tmpdir(), 'rpg-type-config-'));
    seeded.files.push(directory);
    const store = new SqliteReplicaStore(join(directory, 'replica.sqlite'));
    try {
      const resolve = async (userId: string, campaignId: string): Promise<ActorRef | undefined> => {
        const role = roles.get(userId);
        return campaignId === campaign && role !== undefined
          ? { userId, campaignId, role }
          : undefined;
      };
      const entities = new PostgresEntityRepository(content.db);
      const policies = registerResourcePolicies(
        new ResourcePolicyRegistry({ requireVisibilityAdapters: true }),
        [
          new EntityVisibilityAdapter(entities),
          new RelationshipVisibilityAdapter(
            new PostgresRelationshipRepository(content.db),
            entities,
          ),
        ],
      );
      const decider = new AuthorizationService(policies);
      const service = (configuration: typeof CONTENT_CONFIGURATION) =>
        new EntityService({
          entities,
          decider,
          members: { isMember: async (c, u) => (await resolve(u, c)) !== undefined },
          configuration,
        });
      const authorityFor = (configuration: typeof CONTENT_CONFIGURATION) => {
        const appliers = new MutationApplierRegistry();
        appliers.register(
          new EntitySyncMutationApplier(
            service(configuration),
            new LongTextHoldService(new PostgresLongTextHoldRepository(syncDb.db)),
          ),
        );
        return new AuthorityMutationService(
          { resolve },
          appliers,
          new PostgresMutationReceiptStore(syncDb.db),
          mutationAuditParticipantFor(audit.recorder),
        );
      };

      // Device: the GM creates a vehicle offline with the same screens' repository.
      const status = new SyncStatusStore();
      const hub = new ConflictHub();
      const actor = { userId: owner, campaignId: campaign, role: 'owner' as const };
      const local = (configuration: typeof CONTENT_CONFIGURATION) =>
        new EntityLocalRepository(
          new SqliteSyncedRepository<EntityRecord>(
            store,
            ENTITY_REPLICA_TABLE,
            CONTENT_SYNC_FEATURE_ID,
            actor,
            status,
            hub,
          ),
          actor,
          { configuration },
        );
      const device = local(WITH_VEHICLE);
      status.setConnected(false);
      const cart = await device.quickCreate({
        type: VEHICLE.id,
        name: 'Supply Cart',
        summary: 'Creaks',
      });
      if (!cart.ok) throw new Error('local create failed');
      expect(cart.value.visibility).toEqual({ mode: 'gm_only' });
      expect((await device.list({ type: VEHICLE.id })).map((row) => row.name)).toEqual([
        'Supply Cart',
      ]);
      // The shipped configuration refuses it on a device that does not have the entry.
      expect(
        await local(CONTENT_CONFIGURATION).quickCreate({ type: VEHICLE.id, name: 'X' }),
      ).toEqual(err('unknown_type'));
      status.setConnected(true);
      const queue = new MutationQueue(store, status, hub);
      const uploader = (configuration: typeof CONTENT_CONFIGURATION) => ({
        upload: (batch: MutationBatch) =>
          authorityFor(configuration).apply(owner, batch, { sessionId: crypto.randomUUID() }),
      });
      const report = await queue.drainWithOutcomes(
        campaign,
        crypto.randomUUID(),
        uploader(WITH_VEHICLE),
      );
      expect(report.outcomes.map((outcome) => outcome.result)).toEqual(['accepted']);

      // Filter and replicate with the production query (no type predicate anywhere).
      expect((await entities.list(campaign, { type: VEHICLE.id })).map((row) => row.id)).toEqual([
        cart.value.id,
      ]);
      const query =
        compileProviderQueries(
          policies,
          SYNC_RULE_BINDINGS,
          {
            source: 'identity_campaign_memberships',
            userColumn: 'user_id',
            campaignColumn: 'campaign_id',
            roleColumn: 'role',
            removedAtColumn: 'removed_at',
          },
          POSTGRES_DIALECT,
        ).find((item) => item.resourceClass === 'campaign_entity')?.query ?? '';
      expect(query).not.toMatch(/\btype\s*(=|IN)/i);
      const replicated = async (userId: string) =>
        (await db.unsafe<{ id: string; type: string; deleted_at: unknown }[]>(query, [userId]))
          .filter((row) => row.id === cart.value.id)
          .map((row) => ({ type: row.type, deleted: row.deleted_at !== null }));
      expect(await replicated(owner)).toEqual([{ type: VEHICLE.id, deleted: false }]);
      expect(await replicated(player)).toEqual([]);

      // Reveal through feature 04, like every other type.
      const visibility = new VisibilityService({
        registry: policies,
        actors: {
          resolve: async (userId, campaignId) => {
            const found = await resolve(userId, campaignId);
            return found === undefined ? err('membership_not_found') : ok(found);
          },
        },
        audit: audit.recorder,
      });
      const revealed = await visibility.change(owner, {
        campaignId: campaign,
        resourceClass: 'campaign_entity',
        resourceId: cart.value.id,
        operation: 'reveal',
        target: { mode: 'everyone' },
        expectedVersion: 1,
      });
      expect(revealed.status).toBe('changed');
      expect(await replicated(player)).toEqual([{ type: VEHICLE.id, deleted: false }]);

      // The type leaves the configuration: the vehicle stays readable and editable; a new one
      // cannot be created; it can still be deleted, and the tombstone reaches the player.
      const shipped = service(CONTENT_CONFIGURATION);
      const ownerActor = { userId: owner, campaignId: campaign, role: 'owner' as const };
      const renamed = await shipped.update(ownerActor, {
        campaignId: campaign,
        id: cart.value.id,
        expectedVersion: 2,
        changes: { name: 'Old Supply Cart' },
      });
      expect(renamed.ok && renamed.value.type).toBe(VEHICLE.id);
      const refused = await shipped.create(ownerActor, {
        campaignId: campaign,
        id: crypto.randomUUID(),
        type: VEHICLE.id,
        name: 'New cart',
      });
      expect(refused).toEqual({
        ok: false,
        error: { code: 'invalid_payload', reason: 'unknown_type' },
      } as never);
      const removed = await shipped.tombstone(ownerActor, {
        campaignId: campaign,
        id: cart.value.id,
        expectedVersion: 3,
      });
      expect(removed.ok).toBe(true);
      expect(await replicated(player)).toEqual([{ type: VEHICLE.id, deleted: true }]);
    } finally {
      store.close();
      await content.close();
      await syncDb.close();
      await audit.close();
    }
  });
});
