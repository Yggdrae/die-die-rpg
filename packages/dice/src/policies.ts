import type { Capability, Decision, ResourceFacts, ResourcePolicy } from '@rpg/authorization';
import type { ActorRef, Visibility } from '@rpg/contracts';

/**
 * Feature 09 Resource Policy (`_techspec.md`). Read and create only: a roll is never updated, deleted,
 * or revealed (D-09). The Visibility is always explicit: a roll has no default audience.
 */

export const DICE_ROLL_CLASS = 'dice_roll';

const ROLL_CAPABILITIES = ['read', 'create'] as const;

export const DICE_ROLL_POLICY: ResourcePolicy = {
  resourceClass: DICE_ROLL_CLASS,
  capabilities: [...ROLL_CAPABILITIES],
  roleCapabilities: {
    owner: [...ROLL_CAPABILITIES],
    gm: [...ROLL_CAPABILITIES],
    assistant_gm: [...ROLL_CAPABILITIES],
    player: [...ROLL_CAPABILITIES],
    observer: [],
  },
  defaultVisibility: 'explicit',
  sync: {
    kind: 'replicated',
    source: 'dice_rolls',
    campaignColumn: 'campaign_id',
    visibility: { modeColumn: 'visibility_mode', targetsColumn: 'visibility_targets' },
    deletedAtColumn: null,
  },
};

/** `AuthorizationService` (feature 04), structurally. */
export interface RollDecider {
  decide(actor: ActorRef, capability: Capability, facts: ResourceFacts): Decision;
}

/**
 * D-12: an actor can only create a roll they could read. Client-side rolling means the roller's device
 * has seen the result, so a row hidden from the roller could only exist on a replica it must never be
 * on. No role is compared: feature 04 answers both questions, on the device and at the authority.
 */
export function mayCreateRoll(
  decider: RollDecider,
  actor: ActorRef,
  roll: {
    readonly campaignId: string;
    readonly id: string;
    readonly visibility: Visibility;
  },
): boolean {
  const facts: ResourceFacts = {
    campaignId: roll.campaignId,
    resourceClass: DICE_ROLL_CLASS,
    resourceId: roll.id,
    visibility: roll.visibility,
    version: 1,
  };
  return (
    decider.decide(actor, 'create', facts).allowed && decider.decide(actor, 'read', facts).allowed
  );
}
