import {
  CAMPAIGN_REPLICA_TABLE,
  CAMPAIGN_SETTING_REPLICA_TABLE,
  CAMPAIGN_SYNC_FEATURE_ID,
  CampaignReplicaSchema,
  type CampaignService,
  CampaignSettingReplicaSchema,
  campaignCreateInputFromReplica,
} from '@rpg/campaigns';
import type {
  AuthorityMutationContext,
  CreationMutationContext,
  MutationApplier,
  MutationAuditHook,
  PendingMutation,
} from '@rpg/sync';
import { Value } from '@sinclair/typebox/value';

/**
 * A mutation that carries its audit payload is audited once by the authority sync service
 * (feature 06 envelope, origin ID = mutation ID). The service that applies it must therefore not
 * audit post-commit as well, or one change would store two events. The envelope's
 * `recordAudit` hook is handed to the repository write, so the event commits in the domain
 * transaction (`_db.md` Write Path).
 */
function serviceFor(
  mutation: PendingMutation,
  audited: CampaignService,
  unaudited: CampaignService,
): CampaignService {
  return mutation.audit === undefined ? audited : unaudited;
}

export class CampaignSyncMutationApplier implements MutationApplier {
  readonly featureId = CAMPAIGN_SYNC_FEATURE_ID;
  readonly tableName = CAMPAIGN_REPLICA_TABLE;

  /**
   * @param campaigns audits post-commit; used for mutations without an audit envelope (older clients).
   * @param withoutServiceAudit same service wiring with audit discarded; used when the envelope audits.
   */
  constructor(
    private readonly campaigns: CampaignService,
    private readonly withoutServiceAudit: CampaignService = campaigns,
  ) {}

  async apply({ actor, mutation, recordAudit }: AuthorityMutationContext) {
    if (mutation.operation === 'insert') {
      return this.#create(actor.userId, mutation, false, recordAudit);
    }
    const service = serviceFor(mutation, this.campaigns, this.withoutServiceAudit);
    const current = await service.get(actor.userId, mutation.campaignId);
    if (!current.ok) {
      return { status: 'error' as const, code: 'not_found_or_forbidden', retryable: false };
    }
    // Only an insert may carry no base version; a conflict outcome needs a real one (>= 1).
    if (mutation.expectedVersion === null) {
      return { status: 'error' as const, code: 'invalid_campaign_mutation', retryable: false };
    }
    if (mutation.expectedVersion !== current.value.version) {
      return {
        status: 'conflict' as const,
        expectedVersion: mutation.expectedVersion,
        actualVersion: current.value.version,
        currentValue: current.value,
      };
    }
    if (mutation.operation === 'tombstone') {
      const deleted = await service.delete(
        actor.userId,
        mutation.campaignId,
        mutation.expectedVersion,
        recordAudit,
      );
      return deleted.ok
        ? {
            status: 'accepted' as const,
            version: mutation.expectedVersion + 1,
            cursor: `campaign:${mutation.campaignId}:${mutation.expectedVersion + 1}`,
          }
        : this.#error(deleted.error, mutation.expectedVersion, current.value);
    }
    if (mutation.operation !== 'update' || !isDetailsPayload(mutation.payload)) {
      return { status: 'error' as const, code: 'invalid_campaign_mutation', retryable: false };
    }
    const updated = await service.updateDetails(
      actor.userId,
      mutation.campaignId,
      {
        name: mutation.payload.name,
        description: mutation.payload.description,
        expectedVersion: mutation.expectedVersion,
      },
      recordAudit,
    );
    return updated.ok
      ? {
          status: 'accepted' as const,
          version: updated.value.version,
          cursor: `campaign:${mutation.campaignId}:${updated.value.version}`,
        }
      : this.#error(updated.error, mutation.expectedVersion, current.value);
  }

  /**
   * Creation-scoped authorization (feature 03 task 04): no membership exists yet, so the creator
   * is the authenticated uploader and must equal `payload.createdBy`. The owner membership commits
   * in the same transaction; the service re-resolves it before reporting acceptance.
   */
  async applyCreation({ creatorUserId, mutation, recordAudit }: CreationMutationContext) {
    return this.#create(creatorUserId, mutation, true, recordAudit);
  }

  /** Offline creation: the whole aggregate arrives as one mutation and commits atomically. */
  async #create(
    userId: string,
    mutation: PendingMutation,
    creationScoped: boolean,
    recordAudit: MutationAuditHook | undefined,
  ) {
    const payload = mutation.payload;
    if (
      mutation.expectedVersion !== null ||
      !Value.Check(CampaignReplicaSchema, payload) ||
      payload.id !== mutation.recordId ||
      payload.id !== mutation.campaignId ||
      payload.campaignId !== mutation.campaignId ||
      payload.createdBy !== userId
    ) {
      return { status: 'error' as const, code: 'invalid_campaign_mutation', retryable: false };
    }
    const created = await serviceFor(mutation, this.campaigns, this.withoutServiceAudit).create(
      userId,
      campaignCreateInputFromReplica(payload),
      recordAudit,
    );
    if (!created.ok) {
      // Without membership, an existing campaign ID must look like any other denial.
      const hidden =
        creationScoped &&
        (created.error === 'campaign_conflict' || created.error === 'owner_conflict');
      return {
        status: 'error' as const,
        code: hidden
          ? 'not_found_or_forbidden'
          : created.error === 'persistence_unavailable'
            ? 'authority_unavailable'
            : created.error,
        retryable: created.error === 'persistence_unavailable',
      };
    }
    return {
      status: 'accepted' as const,
      version: created.value.version,
      cursor: `campaign:${mutation.campaignId}:${created.value.version}`,
    };
  }

  #error(error: string, expectedVersion: number, current: { readonly version: number }) {
    return error === 'version_conflict'
      ? {
          status: 'conflict' as const,
          expectedVersion,
          actualVersion: current.version,
          currentValue: current,
        }
      : {
          status: 'error' as const,
          code: error === 'persistence_unavailable' ? 'authority_unavailable' : error,
          retryable: error === 'persistence_unavailable',
        };
  }
}

/** Namespaced setting writes; versions are the setting record version, not the campaign's. */
export class CampaignSettingSyncMutationApplier implements MutationApplier {
  readonly featureId = CAMPAIGN_SYNC_FEATURE_ID;
  readonly tableName = CAMPAIGN_SETTING_REPLICA_TABLE;

  constructor(
    private readonly campaigns: CampaignService,
    private readonly withoutServiceAudit: CampaignService = campaigns,
  ) {}

  async apply({ actor, mutation, recordAudit }: AuthorityMutationContext) {
    const payload = mutation.payload;
    if (
      (mutation.operation !== 'insert' && mutation.operation !== 'update') ||
      !Value.Check(CampaignSettingReplicaSchema, payload) ||
      payload.id !== mutation.recordId ||
      payload.campaignId !== mutation.campaignId
    ) {
      return { status: 'error' as const, code: 'invalid_campaign_mutation', retryable: false };
    }
    const service = serviceFor(mutation, this.campaigns, this.withoutServiceAudit);
    const updated = await service.updateSetting(
      actor.userId,
      mutation.campaignId,
      payload.namespace,
      { value: payload.value, expectedVersion: mutation.expectedVersion },
      recordAudit,
    );
    const current = await service.getSetting(actor.userId, mutation.campaignId, payload.namespace);
    if (updated.ok && current.ok) {
      return {
        status: 'accepted' as const,
        version: current.value.version,
        cursor: `campaign_setting:${mutation.campaignId}:${payload.namespace}:${current.value.version}`,
      };
    }
    if (!updated.ok && updated.error === 'version_conflict' && current.ok) {
      // A first write (no base version) colliding with an existing setting has no valid
      // `expectedVersion` (>= 1) to report, so it is a terminal error, not a deferred conflict.
      if (mutation.expectedVersion === null) {
        return { status: 'error' as const, code: 'setting_already_exists', retryable: false };
      }
      return {
        status: 'conflict' as const,
        expectedVersion: mutation.expectedVersion,
        actualVersion: current.value.version,
        currentValue: current.value.value,
      };
    }
    const code = updated.ok ? 'authority_unavailable' : updated.error;
    return {
      status: 'error' as const,
      code: code === 'persistence_unavailable' ? 'authority_unavailable' : code,
      retryable: code === 'persistence_unavailable' || code === 'authority_unavailable',
    };
  }
}

function isDetailsPayload(
  value: unknown,
): value is { readonly name: string; readonly description: string } {
  return (
    value !== null &&
    typeof value === 'object' &&
    'name' in value &&
    typeof value.name === 'string' &&
    'description' in value &&
    typeof value.description === 'string'
  );
}
