import { CAMPAIGN_REPLICA_TABLE, CAMPAIGN_SYNC_FEATURE_ID } from './offline.ts';

/** Structural subset of feature 03's `DrainedMutationOutcome`; campaigns does not import sync. */
export interface CampaignDrainedOutcome {
  readonly campaignId: string;
  readonly featureId: string;
  readonly tableName: string;
  readonly recordId: string;
  readonly operation: string;
  readonly result: string;
}

/** Structural subset of feature 03's `ReplicaAccessReconciler`. */
export interface CampaignReplicaAccess {
  /** Authority-confirmed campaign deletion: destroys the local replica. */
  campaignDeleted(campaignId: string): Promise<unknown>;
  /** Bootstrap answered not-found/forbidden; keeps an unaccepted offline creation. */
  accessDenied(campaignId: string): Promise<unknown>;
}

export interface CampaignSyncDispatchResult {
  /** Per-item failures; a failure never stops later items and never undoes a purge. */
  readonly errors: readonly unknown[];
}

/**
 * Composition glue between feature 03 sync events and the campaign replica (provider-neutral).
 * The device composition calls it after every `MutationQueue.drainWithOutcomes`, for server
 * campaign rows, and for bootstrap denials. It holds no state: invitation queueing is
 * idempotent by intent ID and local destruction is idempotent.
 */
export class CampaignReplicaSync {
  constructor(
    private readonly offline: { authorityAccepted(campaignId: string): Promise<void> },
    private readonly access: CampaignReplicaAccess,
  ) {}

  /**
   * Acts on authority outcomes in causal order: an accepted creation releases its invitation
   * intents; an accepted campaign tombstone destroys the replica. Conflicts, rejections and
   * retries do neither, so a rejected creation never queues an invitation.
   */
  async afterDrain(report: {
    readonly outcomes: readonly CampaignDrainedOutcome[];
  }): Promise<CampaignSyncDispatchResult> {
    const errors: unknown[] = [];
    for (const item of report.outcomes) {
      if (
        item.result !== 'accepted' ||
        item.featureId !== CAMPAIGN_SYNC_FEATURE_ID ||
        item.tableName !== CAMPAIGN_REPLICA_TABLE ||
        item.recordId !== item.campaignId
      ) {
        continue;
      }
      try {
        if (item.operation === 'insert') await this.offline.authorityAccepted(item.recordId);
        else if (item.operation === 'tombstone') await this.access.campaignDeleted(item.recordId);
      } catch (error) {
        errors.push(error);
      }
    }
    return { errors };
  }

  /**
   * Server `campaigns` rows delivered to the replica: a tombstone is authority confirmation of a
   * deletion made elsewhere, so the local context is destroyed.
   */
  async serverCampaigns(
    rows: readonly { readonly id: string; readonly deletedAt?: string | null }[],
  ): Promise<CampaignSyncDispatchResult> {
    const errors: unknown[] = [];
    for (const row of rows) {
      if (row.deletedAt === undefined || row.deletedAt === null) continue;
      try {
        await this.access.campaignDeleted(row.id);
      } catch (error) {
        errors.push(error);
      }
    }
    return { errors };
  }

  /** Bootstrap 404 for a campaign this device holds. */
  bootstrapDenied(campaignId: string): Promise<unknown> {
    return this.access.accessDenied(campaignId);
  }

  /**
   * Restart recovery: the creation was accepted (and persisted as such) but the process stopped
   * before `afterDrain` released the invitations. Safe to repeat; never acts on an unaccepted one.
   */
  async resumeAccepted(
    campaignId: string,
    creationAccepted: (campaignId: string) => boolean,
  ): Promise<void> {
    if (creationAccepted(campaignId)) await this.offline.authorityAccepted(campaignId);
  }
}
