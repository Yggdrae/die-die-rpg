import type { ResourceFacts, ResourcePolicy } from '@rpg/authorization';
import type { RulesMarkRecord } from './records.ts';

/**
 * Feature 14 Resource Policy (`_techspec.md` D-10): a member's bookmarks and history are theirs alone. Every member
 * role may hold marks; an Ownership Rule on every capability, with no exempt role, keeps a GM role out of a player's
 * marks (`_prd.md` "Data and Privacy": a search history reveals intent). Visibility is fixed `players:[user]`.
 */

export const RULES_MARK_CLASS = 'rules_section_mark';

const MARK_CAPABILITIES = ['read', 'create', 'update'] as const;

export const RULES_MARK_POLICY: ResourcePolicy = {
  resourceClass: RULES_MARK_CLASS,
  capabilities: [...MARK_CAPABILITIES],
  roleCapabilities: {
    owner: [...MARK_CAPABILITIES],
    gm: [...MARK_CAPABILITIES],
    assistant_gm: [...MARK_CAPABILITIES],
    player: [...MARK_CAPABILITIES],
    observer: [],
  },
  defaultVisibility: 'explicit',
  ownership: {
    field: 'authorUserId',
    capabilities: [...MARK_CAPABILITIES],
    exemptRoles: [],
  },
  sync: {
    kind: 'replicated',
    source: 'rules_section_marks',
    campaignColumn: 'campaign_id',
    visibility: { modeColumn: 'visibility_mode', targetsColumn: 'visibility_targets' },
    deletedAtColumn: 'deleted_at',
    ownershipColumns: { authorUserId: 'user_id' },
  },
};

export const RULES_RESOURCE_POLICIES: readonly ResourcePolicy[] = [RULES_MARK_POLICY];

export function rulesMarkFacts(
  record: Pick<RulesMarkRecord, 'campaignId' | 'id' | 'version' | 'visibility' | 'userId'>,
): ResourceFacts {
  return {
    campaignId: record.campaignId,
    resourceClass: RULES_MARK_CLASS,
    resourceId: record.id,
    visibility: record.visibility,
    version: record.version,
    authorUserId: record.userId,
  };
}
