import type { ResourceFacts, ResourcePolicy } from '@rpg/authorization';
import type { Visibility } from '@rpg/contracts';
import {
  ENCOUNTER_NOTES_VISIBILITY,
  ENCOUNTER_VISIBILITY,
  PARTICIPANT_STATE_VISIBILITY,
} from './records.ts';

/**
 * Feature 19 Resource Policies (`_techspec.md` "Resource Policies"). An encounter is campaign data every member
 * reads; GM notes and instance states are GM-only; a participant is read by its own Visibility. An instance state is
 * written only through feature 11 (the participant's `update`), so its own class is read-only.
 */

export const ENCOUNTER_CLASS = 'encounter';
export const ENCOUNTER_NOTE_CLASS = 'encounter_gm_note';
export const PARTICIPANT_CLASS = 'encounter_participant';
export const PARTICIPANT_STATE_CLASS = 'encounter_participant_state';

const WRITE = ['read', 'create', 'update'] as const;
const ALL = ['read', 'create', 'update', 'delete'] as const;

function replicated(source: string) {
  return {
    kind: 'replicated' as const,
    source,
    campaignColumn: 'campaign_id',
    visibility: { modeColumn: 'visibility_mode', targetsColumn: 'visibility_targets' },
    deletedAtColumn: 'deleted_at',
  };
}

export const ENCOUNTER_POLICY: ResourcePolicy = {
  resourceClass: ENCOUNTER_CLASS,
  capabilities: [...WRITE],
  roleCapabilities: {
    owner: [...WRITE],
    gm: [...WRITE],
    assistant_gm: [...WRITE],
    player: ['read'],
    observer: [],
  },
  defaultVisibility: ENCOUNTER_VISIBILITY,
  sync: replicated('encounters'),
};

export const ENCOUNTER_NOTE_POLICY: ResourcePolicy = {
  resourceClass: ENCOUNTER_NOTE_CLASS,
  capabilities: [...WRITE],
  roleCapabilities: {
    owner: [...WRITE],
    gm: [...WRITE],
    assistant_gm: [...WRITE],
    player: [],
    observer: [],
  },
  defaultVisibility: ENCOUNTER_NOTES_VISIBILITY,
  sync: replicated('encounter_gm_notes'),
};

export const PARTICIPANT_POLICY: ResourcePolicy = {
  resourceClass: PARTICIPANT_CLASS,
  capabilities: [...ALL],
  roleCapabilities: {
    owner: [...ALL],
    gm: [...ALL],
    assistant_gm: [...ALL],
    player: ['read'],
    observer: [],
  },
  defaultVisibility: 'explicit',
  sync: replicated('encounter_participants'),
};

export const PARTICIPANT_STATE_POLICY: ResourcePolicy = {
  resourceClass: PARTICIPANT_STATE_CLASS,
  capabilities: ['read'],
  roleCapabilities: {
    owner: ['read'],
    gm: ['read'],
    assistant_gm: ['read'],
    player: [],
    observer: [],
  },
  defaultVisibility: PARTICIPANT_STATE_VISIBILITY,
  sync: replicated('encounter_participant_states'),
};

export const ENCOUNTER_RESOURCE_POLICIES: readonly ResourcePolicy[] = [
  ENCOUNTER_POLICY,
  ENCOUNTER_NOTE_POLICY,
  PARTICIPANT_POLICY,
  PARTICIPANT_STATE_POLICY,
];

export function encounterFacts(
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
