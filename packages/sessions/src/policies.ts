import type { ResourceFacts, ResourcePolicy } from '@rpg/authorization';
import type { Visibility } from '@rpg/contracts';
import { NOTES_VISIBILITY, SESSION_VISIBILITY } from './records.ts';

/**
 * Feature 18 Resource Policies (`_techspec.md` "Resource Policies"; D-07: the assistant GM shares the GM view). A
 * session is campaign data every member reads; GM notes are GM-only; a log entry is read by its own Visibility.
 * No class has `delete` or `reveal` in P0: sessions are records, entries are immutable.
 */

export const SESSION_CLASS = 'campaign_session';
export const SESSION_NOTE_CLASS = 'session_gm_note';
export const SESSION_LOG_CLASS = 'session_log_entry';

const WRITE = ['read', 'create', 'update'] as const;
const APPEND = ['read', 'create'] as const;

export const SESSION_POLICY: ResourcePolicy = {
  resourceClass: SESSION_CLASS,
  capabilities: [...WRITE],
  roleCapabilities: {
    owner: [...WRITE],
    gm: [...WRITE],
    assistant_gm: [...WRITE],
    player: ['read'],
    observer: [],
  },
  defaultVisibility: SESSION_VISIBILITY,
  sync: {
    kind: 'replicated',
    source: 'campaign_sessions',
    campaignColumn: 'campaign_id',
    visibility: { modeColumn: 'visibility_mode', targetsColumn: 'visibility_targets' },
    deletedAtColumn: 'deleted_at',
  },
};

export const SESSION_NOTE_POLICY: ResourcePolicy = {
  resourceClass: SESSION_NOTE_CLASS,
  capabilities: [...WRITE],
  roleCapabilities: {
    owner: [...WRITE],
    gm: [...WRITE],
    assistant_gm: [...WRITE],
    player: [],
    observer: [],
  },
  defaultVisibility: NOTES_VISIBILITY,
  sync: {
    kind: 'replicated',
    source: 'session_gm_notes',
    campaignColumn: 'campaign_id',
    visibility: { modeColumn: 'visibility_mode', targetsColumn: 'visibility_targets' },
    deletedAtColumn: 'deleted_at',
  },
};

export const SESSION_LOG_POLICY: ResourcePolicy = {
  resourceClass: SESSION_LOG_CLASS,
  capabilities: [...APPEND],
  roleCapabilities: {
    owner: [...APPEND],
    gm: [...APPEND],
    assistant_gm: [...APPEND],
    player: ['read'],
    observer: [],
  },
  defaultVisibility: 'explicit',
  sync: {
    kind: 'replicated',
    source: 'session_log_entries',
    campaignColumn: 'campaign_id',
    visibility: { modeColumn: 'visibility_mode', targetsColumn: 'visibility_targets' },
    deletedAtColumn: 'deleted_at',
  },
};

export const SESSION_RESOURCE_POLICIES: readonly ResourcePolicy[] = [
  SESSION_POLICY,
  SESSION_NOTE_POLICY,
  SESSION_LOG_POLICY,
];

export function sessionFacts(
  resourceClass: string,
  input: {
    readonly campaignId: string;
    readonly id: string;
    readonly version: number;
    readonly visibility: Visibility;
  },
): ResourceFacts {
  return {
    campaignId: input.campaignId,
    resourceClass,
    resourceId: input.id,
    visibility: input.visibility,
    version: input.version,
  };
}
