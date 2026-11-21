import type { AuditAcknowledgementResolver, CampaignAuditStoreName } from '@rpg/audit';
import type { ActorRef } from '@rpg/contracts';
import type { AuditWatermarkScope, ReplicaScopeEligibility } from '@rpg/sync';
import type { SyncAuditAcknowledgements } from '../sync/routes.ts';
import type { AuditTargetAccess } from './target-access.ts';

/**
 * Feature 06 retention follow-up: audit stores in feature 03's watermark mechanism.
 *
 * - Acknowledgement: a replica names the newest audit event it holds; the event resolves to its
 *   sequence only if the same feature 04 read decision as the audit API and streams permits it
 *   (current target facts, stored snapshot, GM-only narrowing for the private store).
 * - Eligibility: only replicas whose user can receive a store wait on it. The question is asked
 *   as the read decision on the campaign record itself with no narrowing snapshot, which is the
 *   reading-role scope the audit streams join on: campaign readers for the campaign store, GM
 *   roles for the private store. Removed members and non-members resolve no Actor.
 */

const STORES: Readonly<Record<AuditWatermarkScope, CampaignAuditStoreName>> = {
  audit_campaign_events: 'campaign',
  audit_private_events: 'private',
};

export function auditAcknowledgementsFor(deps: {
  readonly targets: Pick<AuditTargetAccess, 'readerFor'>;
  readonly resolvers: Readonly<
    Record<CampaignAuditStoreName, Pick<AuditAcknowledgementResolver, 'resolve'>>
  >;
}): SyncAuditAcknowledgements {
  return {
    resolve: async (actor, tableName, eventId) => {
      const store = STORES[tableName];
      return deps.resolvers[store].resolve(
        actor.campaignId,
        eventId,
        deps.targets.readerFor(actor, store),
      );
    },
  };
}

export function auditReplicaEligibility(deps: {
  /** Feature 01 `ActorResolver` through the sync access port. */
  readonly actors: {
    resolve(userId: string, campaignId: string): Promise<ActorRef | undefined>;
  };
  readonly targets: Pick<AuditTargetAccess, 'readerFor'>;
}): ReplicaScopeEligibility {
  return {
    eligibleUsers: async (campaignId, scope, userIds) => {
      if (!Object.hasOwn(STORES, scope)) return undefined;
      const store = STORES[scope as AuditWatermarkScope];
      const eligible = new Set<string>();
      for (const userId of userIds) {
        const actor = await deps.actors.resolve(userId, campaignId);
        if (actor === undefined) continue;
        const receives = await deps.targets.readerFor(actor, store).permits({
          targetType: 'campaign',
          targetId: campaignId,
          snapshot: { visibility: { mode: 'everyone' } },
        });
        if (receives) eligible.add(userId);
      }
      return eligible;
    },
  };
}
