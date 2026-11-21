import type { ResourceFacts, ResourcePolicy } from '@rpg/authorization';
import type { Visibility } from '@rpg/contracts';
import { characterVisibility } from './records.ts';

/**
 * Feature 15 Resource Policies (D-07). A player reads, creates, changes, and deletes their own character; GM
 * roles all of them. The Visibility `players:[owner]` keeps another player's device from ever receiving it.
 * The GM-only half (D-06) is a class of its own that only GM roles read.
 */

export const CHARACTER_CLASS = 'character';
export const CHARACTER_SECRET_CLASS = 'character_secret';

const ALL = ['read', 'create', 'update', 'delete'] as const;
const GM_ROLES = ['owner', 'gm', 'assistant_gm'] as const;

export const CHARACTER_POLICY: ResourcePolicy = {
  resourceClass: CHARACTER_CLASS,
  capabilities: [...ALL],
  roleCapabilities: {
    owner: [...ALL],
    gm: [...ALL],
    assistant_gm: [...ALL],
    player: [...ALL],
    observer: [],
  },
  defaultVisibility: 'explicit',
  ownership: {
    field: 'authorUserId',
    capabilities: ['update', 'delete'],
    exemptRoles: [...GM_ROLES],
  },
  sync: {
    kind: 'replicated',
    source: 'characters',
    campaignColumn: 'campaign_id',
    visibility: { modeColumn: 'visibility_mode', targetsColumn: 'visibility_targets' },
    deletedAtColumn: 'deleted_at',
  },
};

export const CHARACTER_SECRET_POLICY: ResourcePolicy = {
  resourceClass: CHARACTER_SECRET_CLASS,
  capabilities: ['read'],
  roleCapabilities: {
    owner: ['read'],
    gm: ['read'],
    assistant_gm: ['read'],
    player: [],
    observer: [],
  },
  defaultVisibility: { mode: 'gm_only' },
  sync: {
    kind: 'replicated',
    source: 'character_secrets',
    campaignColumn: 'campaign_id',
    visibility: { modeColumn: 'visibility_mode', targetsColumn: 'visibility_targets' },
    deletedAtColumn: 'deleted_at',
  },
};

export const CHARACTER_RESOURCE_POLICIES: readonly ResourcePolicy[] = [
  CHARACTER_POLICY,
  CHARACTER_SECRET_POLICY,
];

export function characterFacts(input: {
  readonly campaignId: string;
  readonly id: string;
  readonly ownerUserId: string;
  readonly version: number;
  readonly visibility?: Visibility;
}): ResourceFacts {
  return {
    campaignId: input.campaignId,
    resourceClass: CHARACTER_CLASS,
    resourceId: input.id,
    visibility: input.visibility ?? characterVisibility(input.ownerUserId),
    version: input.version,
    authorUserId: input.ownerUserId,
  };
}
