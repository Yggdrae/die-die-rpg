import { EFFECT_AUDIT_ACTIONS, EFFECT_AUDIT_DECLARATIONS } from '@rpg/actions';
import { ATTACHMENT_AUDIT_DECLARATIONS } from '@rpg/attachments';
import { AuditRendererRegistry } from '@rpg/audit';
import { VISIBILITY_AUDIT_DECLARATIONS } from '@rpg/authorization';
import { CAMPAIGN_AUDIT_DECLARATIONS } from '@rpg/campaigns';
import { CHARACTER_AUDIT_ACTIONS, CHARACTER_AUDIT_DECLARATIONS } from '@rpg/characters';
import { CONTENT_AUDIT_ACTIONS, CONTENT_AUDIT_DECLARATIONS } from '@rpg/content';
import { ENCOUNTER_AUDIT_ACTIONS, ENCOUNTER_AUDIT_DECLARATIONS } from '@rpg/encounters';
import { MEMBERSHIP_AUDIT_DECLARATIONS } from '@rpg/identity';
import { SESSION_AUDIT_ACTIONS, SESSION_AUDIT_DECLARATIONS } from '@rpg/sessions';
import { SYNC_AUDIT_DECLARATIONS } from '@rpg/sync';

/**
 * Feature 06 task 06: the conformance inventory of every mutating contributor the feature 06 PRD
 * requires (FR-005), and the registry the API composes from their declarations (FR-006).
 *
 * A `built` contributor names every action it records; each must have a registered declaration
 * with a renderer. A `not_built` contributor has no code yet; its action prefix is reserved, so
 * the first recorded action under it fails `contributors.test.ts` until the feature registers its
 * declarations here. Rows mirror FR-005's feature numbers; the test fails when they diverge.
 */
export interface AuditContributor {
  /** Feature numbers as FR-005 cites them. */
  readonly features: readonly string[];
  readonly requirement: string;
  readonly status: 'built' | 'not_built';
  /** Action prefix (`<prefix>.<verb>`) owned by this contributor. */
  readonly prefix: string;
  /** Every action the built contributor records (all must be registered). */
  readonly actions: readonly string[];
}

export const AUDIT_CONTRIBUTORS: readonly AuditContributor[] = [
  {
    features: ['01'],
    requirement: 'membership and role changes',
    status: 'built',
    prefix: 'membership',
    actions: [
      'membership.created',
      'membership.removed',
      'membership.role_changed',
      'membership.ownership_transferred',
    ],
  },
  {
    features: ['02'],
    requirement: 'campaign creation, deletion and system version change',
    status: 'built',
    prefix: 'campaign',
    actions: [
      'campaign.created',
      'campaign.deleted',
      'campaign.system_updated',
      'campaign.details_updated',
      'campaign.setting_changed',
      'campaign.imported',
    ],
  },
  {
    // Feature 17 reveals through feature 04's Visibility service (same actions).
    features: ['04', '17'],
    requirement: 'visibility and reveal changes',
    status: 'built',
    prefix: 'visibility',
    actions: ['visibility.revealed', 'visibility.unrevealed'],
  },
  {
    features: ['05'],
    requirement: 'attachment upload and delete',
    status: 'built',
    prefix: 'attachment',
    actions: ['attachment.uploaded', 'attachment.deleted'],
  },
  {
    features: ['15'],
    requirement: 'character resource and field changes',
    status: 'built',
    prefix: 'character',
    // Creation and deletion here; every field and resource change is feature 11's `effect.applied`.
    actions: Object.values(CHARACTER_AUDIT_ACTIONS),
  },
  {
    features: ['16'],
    requirement: 'entity create, update and delete',
    status: 'built',
    prefix: 'entity',
    actions: Object.values(CONTENT_AUDIT_ACTIONS),
  },
  {
    features: ['18'],
    requirement: 'session start and end',
    status: 'built',
    prefix: 'session',
    // Start, pause, resume, end, and scene changes; notes and log entries are their own record.
    actions: Object.values(SESSION_AUDIT_ACTIONS),
  },
  {
    features: ['19'],
    requirement: 'encounter changes',
    status: 'built',
    prefix: 'encounter',
    // Start, end, and participant changes; state changes are feature 11's `effect.applied`.
    actions: Object.values(ENCOUNTER_AUDIT_ACTIONS),
  },
  {
    features: ['11'],
    requirement: 'effect applications',
    status: 'built',
    prefix: 'effect',
    actions: Object.values(EFFECT_AUDIT_ACTIONS),
  },
  {
    // TechSpec decision: feature 09 owns roll results and may emit summarized events.
    features: ['09'],
    requirement: 'roll results',
    status: 'not_built',
    prefix: 'roll',
    actions: [],
  },
];

/**
 * Contributors outside FR-005 that record campaign events (registered too, so nothing renders
 * generically by omission). `recovery.issued` is account-scoped (operator-only account store,
 * no campaign reader) and has no campaign renderer.
 */
export const ADDITIONAL_AUDIT_ACTIONS: readonly string[] = ['sync.conflict_resolved'];
export const ACCOUNT_AUDIT_ACTIONS: readonly string[] = ['recovery.issued'];

/** Every contributor declaration, registered once (`invalid`/`duplicate` declarations throw). */
export function createAuditRendererRegistry(): AuditRendererRegistry {
  const registry = new AuditRendererRegistry();
  for (const declaration of [
    ...MEMBERSHIP_AUDIT_DECLARATIONS,
    ...CAMPAIGN_AUDIT_DECLARATIONS,
    ...VISIBILITY_AUDIT_DECLARATIONS,
    ...ATTACHMENT_AUDIT_DECLARATIONS,
    ...CONTENT_AUDIT_DECLARATIONS,
    ...EFFECT_AUDIT_DECLARATIONS,
    ...CHARACTER_AUDIT_DECLARATIONS,
    ...SESSION_AUDIT_DECLARATIONS,
    ...ENCOUNTER_AUDIT_DECLARATIONS,
    ...SYNC_AUDIT_DECLARATIONS,
  ]) {
    registry.register(declaration);
  }
  return registry;
}
