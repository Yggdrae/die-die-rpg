import type { AuthorizationService } from '@rpg/authorization';
import type { CampaignAccessPolicy, CampaignSettingRegistry } from '@rpg/campaigns';

/**
 * Feature 02's access port answered by the feature 04 decision. `write_setting` additionally
 * needs the namespace's declared writable roles; an unknown or missing namespace denies. A read
 * of a campaign-scoped value carries that value's Visibility (a hidden setting is `gm_only`).
 */
export function campaignAccessPolicy(
  authorization: Pick<AuthorizationService, 'decide'>,
  settings: Pick<CampaignSettingRegistry, 'get'>,
): CampaignAccessPolicy {
  return {
    decide: (actor, capability, namespace, visibility = { mode: 'everyone' }) => {
      const decision = authorization.decide(actor, capability, {
        campaignId: actor.campaignId,
        resourceClass: 'campaign',
        resourceId: actor.campaignId,
        visibility,
        version: 1,
      });
      if (!decision.allowed) return false;
      if (capability !== 'write_setting') return true;
      const registration = namespace === undefined ? undefined : settings.get(namespace);
      return registration?.writableRoles.some((writable) => writable === actor.role) ?? false;
    },
  };
}
