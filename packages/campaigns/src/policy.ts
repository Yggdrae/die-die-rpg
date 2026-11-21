import type { ResourcePolicy } from '@rpg/authorization';

/**
 * Campaign rows replicate to every current member with a reading role. `export` (feature 07 FR-004:
 * the whole campaign, GM secrets included) is held by `owner` and `gm` only. Shared with the browser,
 * which applies the same decision before an offline export reads anything.
 */
export const CAMPAIGN_RESOURCE_POLICY: ResourcePolicy = {
  resourceClass: 'campaign',
  capabilities: ['read', 'update', 'delete', 'update_system', 'write_setting', 'export'],
  roleCapabilities: {
    owner: ['read', 'update', 'delete', 'update_system', 'write_setting', 'export'],
    gm: ['read', 'write_setting', 'export'],
    assistant_gm: ['read', 'write_setting'],
    player: ['read', 'write_setting'],
    observer: [],
  },
  defaultVisibility: { mode: 'everyone' },
  sync: {
    kind: 'replicated',
    source: 'campaigns',
    campaignColumn: 'id',
    visibility: 'campaign_wide',
    deletedAtColumn: 'deleted_at',
  },
};
