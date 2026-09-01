import type { CampaignService } from '@rpg/campaigns';
import type { AuthorityMutationContext, MutationApplier } from '@rpg/sync';

export class CampaignSyncMutationApplier implements MutationApplier {
  readonly featureId = 'campaigns';
  readonly tableName = 'campaigns';

  constructor(private readonly campaigns: CampaignService) {}

  async apply({ actor, mutation }: AuthorityMutationContext) {
    const current = await this.campaigns.get(actor.userId, mutation.campaignId);
    if (!current.ok) {
      return { status: 'error' as const, code: 'not_found_or_forbidden', retryable: false };
    }
    if (mutation.expectedVersion === null || mutation.expectedVersion !== current.value.version) {
      return {
        status: 'conflict' as const,
        expectedVersion: mutation.expectedVersion ?? 0,
        actualVersion: current.value.version,
        currentValue: current.value,
      };
    }
    if (mutation.operation === 'tombstone') {
      const deleted = await this.campaigns.delete(
        actor.userId,
        mutation.campaignId,
        mutation.expectedVersion,
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
    const updated = await this.campaigns.updateDetails(actor.userId, mutation.campaignId, {
      name: mutation.payload.name,
      description: mutation.payload.description,
      expectedVersion: mutation.expectedVersion,
    });
    return updated.ok
      ? {
          status: 'accepted' as const,
          version: updated.value.version,
          cursor: `campaign:${mutation.campaignId}:${updated.value.version}`,
        }
      : this.#error(updated.error, mutation.expectedVersion, current.value);
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
