import { DurableRevocationPublisher, type RevocationDeliveryDiagnostics } from '@rpg/sync';
import {
  PostgresReplicaSubscriptionStore,
  PostgresRevocationDeliveryOutbox,
  type SyncDatabase,
} from '@rpg/sync/postgres';
import type { FastifyBaseLogger } from 'fastify';

/** Delivery diagnostics carry IDs, version, reason, attempt, and a safe code only. */
export function revocationDiagnosticsFor(log: FastifyBaseLogger): RevocationDeliveryDiagnostics {
  const fields = (delivery: Parameters<RevocationDeliveryDiagnostics['deliveryFailed']>[0]) => ({
    deliveryId: delivery.deliveryId,
    campaignId: delivery.event.campaignId,
    userId: delivery.event.userId,
    membershipVersion: delivery.event.membershipVersion,
    reason: delivery.event.reason,
    attempt: delivery.attemptCount,
  });
  return {
    deliveryRetrying: (delivery, code, nextAttemptAt) =>
      log.warn(
        { ...fields(delivery), code, nextAttemptAt: nextAttemptAt.toISOString() },
        'campaign access revocation delivery retrying',
      ),
    deliveryFailed: (delivery, code) =>
      log.error({ ...fields(delivery), code }, 'campaign access revocation delivery failed'),
  };
}

/** Production feature 03 revocation delivery over the sync database. */
export function createRevocationDelivery(db: SyncDatabase, log: FastifyBaseLogger) {
  const subscriptions = new PostgresReplicaSubscriptionStore(db);
  const outbox = new PostgresRevocationDeliveryOutbox(db);
  const publisher = new DurableRevocationPublisher(
    outbox,
    [subscriptions],
    revocationDiagnosticsFor(log),
  );
  return { publisher, outbox, subscriptions };
}
