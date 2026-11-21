import type { ResourcePolicy } from '@rpg/authorization';

/**
 * Feature 16 Resource Policies (`_techspec.md` "Resource Policies"; D-04 players read only, D-05
 * `owner`/`gm`/`assistant_gm` identical, D-06 personal notes for players only). Registered by the
 * API composition with the feature 04 registry; the sync stream queries are compiled from these
 * declarations (`sync-config.yaml` `authorized_content`, drift-gated).
 */

export const CAMPAIGN_ENTITY_CLASS = 'campaign_entity';
export const PERSONAL_NOTE_CLASS = 'personal_note';
export const ENTITY_RELATIONSHIP_CLASS = 'entity_relationship';

const ENTITY_GM_CAPABILITIES = ['read', 'create', 'update', 'delete', 'reveal'] as const;

/** Every entity type, one class. GM-authored content is GM-only by default (FR-010, BR-002). */
export const CAMPAIGN_ENTITY_POLICY: ResourcePolicy = {
  resourceClass: CAMPAIGN_ENTITY_CLASS,
  capabilities: [...ENTITY_GM_CAPABILITIES],
  roleCapabilities: {
    owner: [...ENTITY_GM_CAPABILITIES],
    gm: [...ENTITY_GM_CAPABILITIES],
    assistant_gm: [...ENTITY_GM_CAPABILITIES],
    player: ['read'],
    observer: [],
  },
  defaultVisibility: { mode: 'gm_only' },
  revealTargets: ['players'],
  sync: {
    kind: 'replicated',
    source: 'content_entities',
    campaignColumn: 'campaign_id',
    visibility: { modeColumn: 'visibility_mode', targetsColumn: 'visibility_targets' },
    deletedAtColumn: 'deleted_at',
  },
};

const NOTE_CAPABILITIES = ['read', 'create', 'update', 'delete'] as const;

/**
 * A player's private note (BR-007): readable and writable by its author only, GM roles included
 * (Ownership Rule on every capability, no exempt role). Visibility is fixed `players:[author]`
 * (`explicit` default, no `reveal`).
 */
export const PERSONAL_NOTE_POLICY: ResourcePolicy = {
  resourceClass: PERSONAL_NOTE_CLASS,
  capabilities: [...NOTE_CAPABILITIES],
  roleCapabilities: {
    owner: [],
    gm: [],
    assistant_gm: [],
    player: [...NOTE_CAPABILITIES],
    observer: [],
  },
  defaultVisibility: 'explicit',
  ownership: {
    field: 'authorUserId',
    capabilities: [...NOTE_CAPABILITIES],
    exemptRoles: [],
  },
  sync: {
    kind: 'replicated',
    source: 'content_personal_notes',
    campaignColumn: 'campaign_id',
    visibility: { modeColumn: 'visibility_mode', targetsColumn: 'visibility_targets' },
    deletedAtColumn: 'deleted_at',
    ownershipColumns: { authorUserId: 'author_user_id' },
  },
};

/**
 * A typed relationship between two entities (task 08). Same matrix as `campaign_entity` (D-04,
 * D-05); GM-only by default (BR-005). Its Visibility is never wider than either endpoint's: the
 * bound is maintained on write (relationship writes refuse, endpoint narrowing narrows; D-07
 * option A), because a per-row sync predicate cannot read the endpoints.
 */
export const ENTITY_RELATIONSHIP_POLICY: ResourcePolicy = {
  resourceClass: ENTITY_RELATIONSHIP_CLASS,
  capabilities: [...ENTITY_GM_CAPABILITIES],
  roleCapabilities: {
    owner: [...ENTITY_GM_CAPABILITIES],
    gm: [...ENTITY_GM_CAPABILITIES],
    assistant_gm: [...ENTITY_GM_CAPABILITIES],
    player: ['read'],
    observer: [],
  },
  defaultVisibility: { mode: 'gm_only' },
  revealTargets: ['players'],
  sync: {
    kind: 'replicated',
    source: 'content_entity_relationships',
    campaignColumn: 'campaign_id',
    visibility: { modeColumn: 'visibility_mode', targetsColumn: 'visibility_targets' },
    deletedAtColumn: 'deleted_at',
  },
};

export const CONTENT_RESOURCE_POLICIES: readonly ResourcePolicy[] = [
  CAMPAIGN_ENTITY_POLICY,
  PERSONAL_NOTE_POLICY,
  ENTITY_RELATIONSHIP_POLICY,
];

/**
 * Feature 05 attachment owner classes contributed by feature 16 (FR-009): entities only. Personal
 * notes and relationships take no attachments (D-15). The API composition passes this list to
 * `buildRuntimeApp({ attachments: { ownerClasses } })`.
 */
export const CONTENT_ATTACHMENT_OWNER_CLASSES: readonly string[] = [CAMPAIGN_ENTITY_CLASS];
