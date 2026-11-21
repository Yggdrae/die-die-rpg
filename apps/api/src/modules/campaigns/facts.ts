import type { CampaignRepository } from '@rpg/campaigns';
import type { ResourceFactsSource } from '../authorization/content-access.ts';

/**
 * `campaign` registers no Visibility adapter; a campaign is its own record (long-text holds,
 * audit readership, `campaign.*` audit targets). A deleted or unknown campaign has no facts.
 */
export function campaignFactsSource(
  repository: Pick<CampaignRepository, 'get'>,
): ResourceFactsSource {
  return {
    resourceClass: 'campaign',
    loadFacts: async (campaignId, resourceId) => {
      const campaign = resourceId === campaignId ? await repository.get(campaignId) : undefined;
      return campaign === undefined || campaign.deletedAt !== undefined
        ? undefined
        : {
            campaignId,
            resourceClass: 'campaign',
            resourceId,
            visibility: { mode: 'everyone' },
            version: campaign.version,
          };
    },
  };
}
