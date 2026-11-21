import {
  EFFECT_APPLICATION_CLASS,
  EFFECT_APPLICATION_POLICY,
  effectReplicaProjection,
} from '@rpg/actions';
import type { ResourcePolicy, ResourcePolicyRegistry, VisibilityAdapter } from '@rpg/authorization';
import { CAMPAIGN_RESOURCE_POLICY } from '@rpg/campaigns/policy';
import {
  CHARACTER_CLASS,
  CHARACTER_POLICY,
  CHARACTER_SECRET_CLASS,
  CHARACTER_SECRET_POLICY,
  characterReplicaProjection,
} from '@rpg/characters';
import {
  CAMPAIGN_ENTITY_CLASS,
  CAMPAIGN_ENTITY_POLICY,
  ENTITY_RELATIONSHIP_CLASS,
  ENTITY_RELATIONSHIP_POLICY,
  PERSONAL_NOTE_CLASS,
  PERSONAL_NOTE_POLICY,
  replicaProjection,
} from '@rpg/content';
import { DICE_ROLL_CLASS, DICE_ROLL_POLICY, diceReplicaProjection } from '@rpg/dice';
import {
  ENCOUNTER_CLASS,
  ENCOUNTER_NOTE_CLASS,
  ENCOUNTER_NOTE_POLICY,
  ENCOUNTER_POLICY,
  encounterReplicaProjection,
  PARTICIPANT_CLASS,
  PARTICIPANT_POLICY,
  PARTICIPANT_STATE_CLASS,
  PARTICIPANT_STATE_POLICY,
} from '@rpg/encounters';
import { RULES_MARK_CLASS, RULES_MARK_POLICY, rulesReplicaProjection } from '@rpg/rules';
import {
  SESSION_CLASS,
  SESSION_LOG_CLASS,
  SESSION_LOG_POLICY,
  SESSION_NOTE_CLASS,
  SESSION_NOTE_POLICY,
  SESSION_POLICY,
  sessionReplicaProjection,
} from '@rpg/sessions';
import type { AuditSyncStore, SyncRuleBinding } from '@rpg/sync';

/**
 * Registered Resource Classes and their sync-provider bindings (feature 04 task 05). The
 * PowerSync stream queries in `infra/powersync/sync-config.yaml` for these classes are the
 * compiled output of these declarations; `sync-config.integration.test.ts` fails on any drift.
 */

export { CAMPAIGN_RESOURCE_POLICY };

/**
 * Membership changes as audit targets (feature 01 `membership.*` events, feature 06 task 03).
 * Server-only: membership rows reach devices through the platform membership stream, never as a
 * content class, so this declaration adds no sync stream (the YAML does not change).
 *
 * Readers are the GM roles only. Feature 01 and 06 specs record membership changes but name no
 * reader; this is the narrowest defensible rule (players and observers learn their own role from
 * their membership row). Approved (2026-10-28, delegated by owner); widening to players for their
 * own membership would be a policy-only change.
 */
export const CAMPAIGN_MEMBERSHIP_RESOURCE_POLICY: ResourcePolicy = {
  resourceClass: 'campaign_membership',
  capabilities: ['read'],
  roleCapabilities: {
    owner: ['read'],
    gm: ['read'],
    assistant_gm: ['read'],
    player: [],
    observer: [],
  },
  defaultVisibility: { mode: 'gm_only' },
  sync: { kind: 'server_only' },
};

/**
 * Feature 16 task 03: `campaign_entity` (every entity type; reveal-capable, registered with its
 * Visibility adapter by the runtime) and `personal_note` (author-private, no reveal). Task 08:
 * `entity_relationship` (reveal-capable, bounded by its endpoints, with its own adapter).
 */
export const REGISTERED_RESOURCE_POLICIES: readonly ResourcePolicy[] = [
  CAMPAIGN_RESOURCE_POLICY,
  CAMPAIGN_MEMBERSHIP_RESOURCE_POLICY,
  CAMPAIGN_ENTITY_POLICY,
  PERSONAL_NOTE_POLICY,
  ENTITY_RELATIONSHIP_POLICY,
  // Feature 09: read and create only, Visibility set at creation, no reveal.
  DICE_ROLL_POLICY,
  // Feature 11: read, create, and `override`; Visibility set by the authority from the target.
  EFFECT_APPLICATION_POLICY,
  // Feature 15: characters (Ownership Rule on update and delete) and their GM-only half.
  CHARACTER_POLICY,
  CHARACTER_SECRET_POLICY,
  // Feature 18: sessions (every member), GM notes (GM roles), log entries (their own Visibility).
  SESSION_POLICY,
  SESSION_NOTE_POLICY,
  SESSION_LOG_POLICY,
  // Feature 19: encounters (every member), GM notes and instance states (GM roles), participants
  // (their own Visibility).
  ENCOUNTER_POLICY,
  ENCOUNTER_NOTE_POLICY,
  PARTICIPANT_POLICY,
  PARTICIPANT_STATE_POLICY,
  // Feature 14: a member's own section marks (Ownership Rule on every capability, no exempt role).
  RULES_MARK_POLICY,
];

/**
 * Registers every declaration, each with its Visibility adapter when one is supplied. A registry
 * built with `requireVisibilityAdapters` (the runtime) rejects a reveal-capable class without one;
 * an adapter for an unregistered class is a composition error.
 */
export function registerResourcePolicies(
  registry: ResourcePolicyRegistry,
  adapters: readonly VisibilityAdapter[] = [],
): ResourcePolicyRegistry {
  const byClass = new Map(adapters.map((adapter) => [adapter.resourceClass, adapter]));
  for (const policy of REGISTERED_RESOURCE_POLICIES) {
    registry.register(policy, byClass.get(policy.resourceClass));
    byClass.delete(policy.resourceClass);
  }
  const [orphan] = byClass.keys();
  if (orphan !== undefined) throw new Error(`visibility adapter for unregistered class: ${orphan}`);
  return registry;
}

/** Stream placement and the approved replicated columns of each replicated class. */
export const SYNC_RULE_BINDINGS: readonly SyncRuleBinding[] = [
  {
    resourceClass: 'campaign',
    stream: 'authorized_campaigns',
    columns: [
      'id',
      'name',
      'description',
      'game_mode',
      'created_by',
      'version',
      'created_at',
      'updated_at',
      'deleted_at',
    ],
  },
  // Feature 16 task 04: one stream for campaign content. The projections are the device replica
  // tables (`CONTENT_REPLICA_TABLES`), so the stream and the browser schema cannot drift apart.
  {
    resourceClass: CAMPAIGN_ENTITY_CLASS,
    stream: 'authorized_content',
    columns: replicaProjection('content_entities'),
  },
  {
    resourceClass: PERSONAL_NOTE_CLASS,
    stream: 'authorized_content',
    columns: replicaProjection('content_personal_notes'),
  },
  // Task 08: relationships. Per-row predicate only (PowerSync 1.25.0); the endpoint bound is a
  // write-time invariant (D-07 option A), so this row never outruns its endpoints.
  {
    resourceClass: ENTITY_RELATIONSHIP_CLASS,
    stream: 'authorized_content',
    columns: replicaProjection('content_entity_relationships'),
  },
  // Feature 09: recorded rolls. A hidden roll is simply outside this per-row predicate for a player,
  // so it is absent from their replica rather than filtered at rendering.
  {
    resourceClass: DICE_ROLL_CLASS,
    stream: 'authorized_rolls',
    columns: diceReplicaProjection(),
  },
  // Feature 11: effect applications, for the device overlay and the session log.
  {
    resourceClass: EFFECT_APPLICATION_CLASS,
    stream: 'authorized_effects',
    columns: effectReplicaProjection(),
  },
  // Feature 15: a character reaches its owner and the GM roles; its secret row the GM roles only.
  {
    resourceClass: CHARACTER_CLASS,
    stream: 'authorized_characters',
    columns: characterReplicaProjection('characters'),
  },
  {
    resourceClass: CHARACTER_SECRET_CLASS,
    stream: 'authorized_characters',
    columns: characterReplicaProjection('character_secrets'),
  },
  // Feature 18: one stream; GM notes compile to `gm_only`, so a player replica never holds them.
  {
    resourceClass: SESSION_CLASS,
    stream: 'authorized_sessions',
    columns: sessionReplicaProjection('campaign_sessions'),
  },
  {
    resourceClass: SESSION_NOTE_CLASS,
    stream: 'authorized_sessions',
    columns: sessionReplicaProjection('session_gm_notes'),
  },
  {
    resourceClass: SESSION_LOG_CLASS,
    stream: 'authorized_sessions',
    columns: sessionReplicaProjection('session_log_entries'),
  },
  // Feature 19: one stream; GM notes and instance states compile to `gm_only`, so a player replica
  // never holds enemy statistics.
  {
    resourceClass: ENCOUNTER_CLASS,
    stream: 'authorized_encounters',
    columns: encounterReplicaProjection('encounters'),
  },
  {
    resourceClass: ENCOUNTER_NOTE_CLASS,
    stream: 'authorized_encounters',
    columns: encounterReplicaProjection('encounter_gm_notes'),
  },
  {
    resourceClass: PARTICIPANT_CLASS,
    stream: 'authorized_encounters',
    columns: encounterReplicaProjection('encounter_participants'),
  },
  {
    resourceClass: PARTICIPANT_STATE_CLASS,
    stream: 'authorized_encounters',
    columns: encounterReplicaProjection('encounter_participant_states'),
  },
  {
    resourceClass: RULES_MARK_CLASS,
    stream: 'authorized_rules_marks',
    columns: rulesReplicaProjection(),
  },
];

/**
 * Feature 06 task 04: the two physical audit stores, each in its own stream. Both are windowed by
 * explicit subscription (campaign, accepted month); neither is subscribed by default. The private
 * stream's query admits GM reading roles only, and a client subscribes to it only while it holds
 * a GM role in that campaign, so a player replica never addresses the private table.
 */
const AUDIT_PROJECTION = [
  'id',
  'campaign_id',
  'session_id',
  'actor_user_id',
  'actor_role',
  'action',
  'target_type',
  'target_id',
  'before_value',
  'after_value',
  'client_recorded_at',
  'accepted_at',
  'renderer_version',
] as const;

const AUDIT_COLUMNS = {
  campaign: 'campaign_id',
  targetType: 'target_type',
  targetId: 'target_id',
  snapshot: 'target_visibility',
  acceptedAt: 'accepted_at',
} as const;

export const AUDIT_SYNC_STORES: readonly AuditSyncStore[] = [
  {
    store: 'campaign',
    source: 'audit_campaign_events',
    stream: 'campaign_audit',
    projection: AUDIT_PROJECTION,
    columns: AUDIT_COLUMNS,
  },
  {
    store: 'private',
    source: 'audit_private_events',
    stream: 'gm_private_audit',
    projection: AUDIT_PROJECTION,
    columns: AUDIT_COLUMNS,
  },
];
