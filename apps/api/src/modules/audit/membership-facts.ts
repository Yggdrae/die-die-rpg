import type { MembershipHistoryFact } from '@rpg/identity';
import type { ResourceFactsSource } from '../authorization/content-access.ts';

/** The identity public boundary this source needs (`MembershipService.historyFact`). */
export interface MembershipHistoryReader {
  historyFact(campaignId: string, userId: string): Promise<MembershipHistoryFact | undefined>;
}

/**
 * Facts for `campaign_membership` audit targets (feature 06 task 03). The resource ID is the
 * member's user ID, as feature 01 records it. A removed membership still resolves, so its history
 * stays readable under the same rule; a user with no membership row in the campaign has no facts
 * and the event stays hidden. The membership store is reached only through identity's public API.
 *
 * Visibility is always `gm_only` (the class default, mirrored here because the record carries none).
 * Used for audit reads only: it is deliberately not registered with `ContentAccess`, so no content
 * or hold route can address this class.
 */
export function membershipFactsSource(memberships: MembershipHistoryReader): ResourceFactsSource {
  return {
    resourceClass: 'campaign_membership',
    loadFacts: async (campaignId, resourceId) => {
      const fact = await memberships.historyFact(campaignId, resourceId);
      if (fact === undefined || fact.campaignId !== campaignId || fact.userId !== resourceId) {
        return undefined;
      }
      return {
        campaignId,
        resourceClass: 'campaign_membership',
        resourceId,
        visibility: { mode: 'gm_only' },
        version: fact.version,
      };
    },
  };
}
