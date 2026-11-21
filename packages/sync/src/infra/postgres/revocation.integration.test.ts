import { afterAll, describe, expect, test } from 'bun:test';
import type { CampaignAccessRevoked, TombstoneRef } from '@rpg/contracts';
import postgres from 'postgres';
import { DurableRevocationPublisher } from '../../revocation-delivery.ts';
import {
  connectSyncDatabase,
  PostgresReplicaSubscriptionStore,
  PostgresRevocationDeliveryOutbox,
  PostgresTombstonePurgeEvidence,
  PostgresWatermarkStore,
} from './store.ts';

/**
 * Feature 03 task 07 server adapters on PostgreSQL: durable revocation outbox, subscription
 * invalidation, watermark acknowledgement, and the guarded tombstone purge decision.
 * Skipped when no database is reachable.
 */

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const probe =
  databaseUrl === undefined ? undefined : postgres(databaseUrl, { max: 1, onnotice: () => {} });
const available = await (async () => {
  if (probe === undefined) return false;
  try {
    await probe`select 1 from sync_access_revocations limit 1`;
    return true;
  } catch {
    return false;
  }
})();
const connection =
  available && databaseUrl !== undefined ? connectSyncDatabase(databaseUrl) : undefined;
const campaigns: string[] = [];

afterAll(async () => {
  if (probe !== undefined && campaigns.length > 0) {
    await probe`delete from sync_access_revocations where campaign_id = any(${campaigns}::uuid[])`;
    await probe`delete from sync_replica_subscriptions where campaign_id = any(${campaigns}::uuid[])`;
    await probe`delete from sync_replica_watermarks where campaign_id = any(${campaigns}::uuid[])`;
  }
  await connection?.close();
  await probe?.end({ timeout: 1 });
});

function newCampaign(): string {
  const id = crypto.randomUUID();
  campaigns.push(id);
  return id;
}

const DAY = 24 * 60 * 60 * 1_000;

describe.skipIf(!available)('feature 03 revocation and watermark adapters (PostgreSQL)', () => {
  test('outbox is idempotent; degraded delivery is observable, retried, then delivered', async () => {
    if (connection === undefined || probe === undefined) return;
    const outbox = new PostgresRevocationDeliveryOutbox(connection.db);
    const subscriptions = new PostgresReplicaSubscriptionStore(connection.db);
    const campaignId = newCampaign();
    const userId = crypto.randomUUID();
    const replicaId = crypto.randomUUID();
    await subscriptions.register({ campaignId, userId, replicaId, subscribedAt: new Date() });
    let down = true;
    const retrying: string[] = [];
    let now = new Date(Date.now() + 1_000);
    const publisher = new DurableRevocationPublisher(
      outbox,
      [
        {
          invalidate: async (event) => {
            if (down) throw Object.assign(new Error('x'), { code: 'provider_unavailable' });
            await subscriptions.invalidate(event);
          },
        },
      ],
      {
        deliveryRetrying: (_delivery, code) => retrying.push(code),
        deliveryFailed: () => undefined,
      },
      { baseBackoffMs: 1_000, clock: () => now },
    );
    const event: CampaignAccessRevoked = {
      campaignId,
      userId,
      membershipVersion: 2,
      reason: 'removed',
      committedAt: new Date(Date.now() + 500).toISOString(),
    };

    await publisher.publish(event);
    await publisher.publish(event);
    const rows = await probe`
      select state, attempt_count, last_error_code from sync_access_revocations
      where campaign_id = ${campaignId}`;
    expect([...rows]).toEqual([
      { state: 'pending', attempt_count: 1, last_error_code: 'provider_unavailable' },
    ]);
    expect(retrying).toEqual(['provider_unavailable']);
    const [subscription] = await probe`
      select revoked_at from sync_replica_subscriptions where replica_id = ${replicaId}`;
    expect(subscription?.revoked_at).toBeNull();

    down = false;
    now = new Date(now.getTime() + 2_000);
    const pass = await publisher.retryDue(500);
    expect(pass.delivered).toBeGreaterThanOrEqual(1);
    const [delivered] = await probe`
      select state, delivered_at from sync_access_revocations where campaign_id = ${campaignId}`;
    expect(delivered?.state).toBe('delivered');
    const [revoked] = await probe`
      select revoked_at from sync_replica_subscriptions where replica_id = ${replicaId}`;
    expect(revoked?.revoked_at).not.toBeNull();
  });

  test('role change keeps subscriptions; stale removal never revokes a later re-subscription', async () => {
    if (connection === undefined || probe === undefined) return;
    const subscriptions = new PostgresReplicaSubscriptionStore(connection.db);
    const campaignId = newCampaign();
    const userId = crypto.randomUUID();
    const replicaId = crypto.randomUUID();
    const earlier = new Date(Date.now() - 60_000).toISOString();
    await subscriptions.register({ campaignId, userId, replicaId, subscribedAt: new Date() });
    await subscriptions.invalidate({
      campaignId,
      userId,
      membershipVersion: 2,
      reason: 'role_changed',
      committedAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await subscriptions.invalidate({
      campaignId,
      userId,
      membershipVersion: 1,
      reason: 'removed',
      committedAt: earlier,
    });
    const [row] = await probe`
      select revoked_at from sync_replica_subscriptions where replica_id = ${replicaId}`;
    expect(row?.revoked_at).toBeNull();
    // Another user cannot claim the replica id.
    await subscriptions.register({
      campaignId,
      userId: crypto.randomUUID(),
      replicaId,
      subscribedAt: new Date(),
    });
    const [owner] = await probe`
      select user_id from sync_replica_subscriptions where replica_id = ${replicaId}`;
    expect(owner?.user_id).toBe(userId);
  });

  test('purge decision: age, every eligible acknowledgement, and no pending reference', async () => {
    if (connection === undefined || probe === undefined) return;
    const evidence = new PostgresTombstonePurgeEvidence(connection.db);
    const watermarks = new PostgresWatermarkStore(connection.db);
    const subscriptions = new PostgresReplicaSubscriptionStore(connection.db);
    const campaignId = newCampaign();
    const alice = crypto.randomUUID();
    const bob = crypto.randomUUID();
    const aliceReplica = crypto.randomUUID();
    const bobReplica = crypto.randomUUID();
    const lateReplica = crypto.randomUUID();
    const recordId = crypto.randomUUID();
    await subscriptions.register({
      campaignId,
      userId: alice,
      replicaId: aliceReplica,
      subscribedAt: new Date(),
    });
    await subscriptions.register({
      campaignId,
      userId: bob,
      replicaId: bobReplica,
      subscribedAt: new Date(),
    });
    const deletedAt = new Date(Date.now() + 1_000).toISOString();
    const tombstone: TombstoneRef = {
      campaignId,
      scope: 'campaigns',
      recordId,
      sequence: 7,
      deletedAt,
    };
    const tooSoon = new Date(Date.parse(deletedAt) + DAY);
    const later = new Date(Date.parse(deletedAt) + 91 * DAY);

    expect(await evidence.decide(tombstone, tooSoon)).toEqual({
      safe: false,
      blockers: ['minimum_age', 'unacknowledged_replica'],
    });

    await evidence.acknowledge(
      {
        campaignId,
        userId: alice,
        replicaId: aliceReplica,
        scope: 'campaigns',
        sequence: 7,
        acknowledgedAt: new Date().toISOString(),
      },
      [recordId],
    );
    expect(await evidence.decide(tombstone, later)).toEqual({
      safe: false,
      blockers: ['unacknowledged_replica', 'pending_mutation_reference'],
    });

    // Bob's replica is revoked (marked for destruction); Alice re-acknowledges without the record.
    await watermarks.replicaDropped({ campaignId, userId: bob, replicaId: bobReplica });
    await watermarks.acknowledge({
      campaignId,
      userId: alice,
      replicaId: aliceReplica,
      tableName: 'campaigns',
      sequence: 8,
    });
    // A lower acknowledgement never moves the watermark back, nor can another user overwrite it.
    await watermarks.acknowledge({
      campaignId,
      userId: alice,
      replicaId: aliceReplica,
      tableName: 'campaigns',
      sequence: 1,
      pendingRecordIds: [recordId],
    });
    await watermarks.acknowledge({
      campaignId,
      userId: bob,
      replicaId: aliceReplica,
      tableName: 'campaigns',
      sequence: 9,
      pendingRecordIds: [recordId],
    });
    // A replica subscribed after the deletion is not an eligible subscriber.
    await probe`insert into sync_replica_subscriptions (campaign_id, replica_id, user_id, subscribed_at)
      values (${campaignId}, ${lateReplica}, ${bob}, ${new Date(Date.parse(deletedAt) + DAY)})`;

    expect(await evidence.decide(tombstone, tooSoon)).toEqual({
      safe: false,
      blockers: ['minimum_age'],
    });
    expect(await evidence.decide(tombstone, later)).toEqual({ safe: true });
    const [mark] = await probe`
      select acknowledged_sequence::int as sequence, pending_record_ids, user_id
      from sync_replica_watermarks where replica_id = ${aliceReplica}`;
    expect(mark).toEqual({ sequence: 8, pending_record_ids: [], user_id: alice });
  });

  test('scope eligibility: replicas that never receive a scope do not hold it back', async () => {
    if (connection === undefined) return;
    const campaignId = newCampaign();
    const gm = crypto.randomUUID();
    const player = crypto.randomUUID();
    const gmReplica = crypto.randomUUID();
    const playerReplica = crypto.randomUUID();
    const subscriptions = new PostgresReplicaSubscriptionStore(connection.db);
    const watermarks = new PostgresWatermarkStore(connection.db);
    const subscribedAt = new Date(Date.now() - 500 * DAY);
    for (const [userId, replicaId] of [
      [gm, gmReplica],
      [player, playerReplica],
    ] as const) {
      await subscriptions.register({ campaignId, userId, replicaId, subscribedAt });
    }
    const asked: { scope: string; userIds: readonly string[] }[] = [];
    // The GM-private scope reaches GM replicas only; other scopes keep every subscriber.
    const evidence = new PostgresTombstonePurgeEvidence(connection.db, watermarks, {
      eligibleUsers: async (_campaign, scope, userIds) => {
        asked.push({ scope, userIds: [...userIds].sort() });
        return scope === 'audit_private_events' ? new Set([gm]) : undefined;
      },
    });
    const ref = (scope: string): TombstoneRef => ({
      campaignId,
      scope,
      recordId: crypto.randomUUID(),
      sequence: 5,
      deletedAt: new Date(Date.now() - 400 * DAY).toISOString(),
    });
    const now = new Date();
    expect(await evidence.decide(ref('audit_private_events'), now)).toEqual({
      safe: false,
      blockers: ['unacknowledged_replica'],
    });
    expect(asked[0]).toEqual({ scope: 'audit_private_events', userIds: [gm, player].sort() });
    await watermarks.acknowledge({
      campaignId,
      userId: gm,
      replicaId: gmReplica,
      tableName: 'audit_private_events',
      sequence: 5,
    });
    // The player never acknowledges the private scope and never blocks it.
    expect(await evidence.decide(ref('audit_private_events'), now)).toEqual({ safe: true });
    // Every subscriber is eligible for the campaign scope: the player still blocks it.
    await watermarks.acknowledge({
      campaignId,
      userId: gm,
      replicaId: gmReplica,
      tableName: 'audit_campaign_events',
      sequence: 5,
    });
    expect(await evidence.decide(ref('audit_campaign_events'), now)).toEqual({
      safe: false,
      blockers: ['unacknowledged_replica'],
    });
    // A pending reference by an ineligible replica is ignored too.
    const record = ref('audit_private_events');
    await watermarks.acknowledge({
      campaignId,
      userId: player,
      replicaId: playerReplica,
      tableName: 'audit_private_events',
      sequence: 0,
      pendingRecordIds: [record.recordId],
    });
    expect(await evidence.decide(record, now)).toEqual({ safe: true });
    // An eligibility failure fails the decision (the caller treats it as not safe).
    const failing = new PostgresTombstonePurgeEvidence(connection.db, watermarks, {
      eligibleUsers: async () => {
        throw new Error('roles unavailable');
      },
    });
    let failed = false;
    try {
      await failing.decide(ref('audit_private_events'), now);
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
  });
});
