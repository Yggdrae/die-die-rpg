import type { Capability, Decision, ResourceFacts, ResourcePolicy } from '@rpg/authorization';
import type { ActorRef, Visibility } from '@rpg/contracts';

/**
 * Feature 11 Resource Policy (`_techspec.md`). Read and create for members; `override`, the right to apply
 * a plan edited by hand, for GM roles (D-15). Who may touch a target is the target's own class's `update`
 * decision, so an owner's Ownership Rule applies without this feature knowing it.
 */

export const EFFECT_APPLICATION_CLASS = 'effect_application';
export const EFFECT_OVERRIDE_CAPABILITY: Capability = 'override';

const GM_CAPABILITIES = ['read', 'create', EFFECT_OVERRIDE_CAPABILITY];

export const EFFECT_APPLICATION_POLICY: ResourcePolicy = {
  resourceClass: EFFECT_APPLICATION_CLASS,
  capabilities: GM_CAPABILITIES,
  roleCapabilities: {
    owner: GM_CAPABILITIES,
    gm: GM_CAPABILITIES,
    assistant_gm: GM_CAPABILITIES,
    player: ['read', 'create'],
    observer: [],
  },
  defaultVisibility: 'explicit',
  sync: {
    kind: 'replicated',
    source: 'effect_applications',
    campaignColumn: 'campaign_id',
    visibility: { modeColumn: 'visibility_mode', targetsColumn: 'visibility_targets' },
    deletedAtColumn: null,
  },
};

/** `AuthorizationService` (feature 04), structurally. */
export interface EffectDecider {
  decide(actor: ActorRef, capability: Capability, facts: ResourceFacts): Decision;
}

export function effectFacts(input: {
  readonly campaignId: string;
  readonly id: string;
  readonly visibility: Visibility;
}): ResourceFacts {
  return {
    campaignId: input.campaignId,
    resourceClass: EFFECT_APPLICATION_CLASS,
    resourceId: input.id,
    visibility: input.visibility,
    version: 1,
  };
}
