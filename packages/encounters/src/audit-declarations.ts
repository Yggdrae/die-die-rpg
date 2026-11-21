import { type TSchema, Type } from '@sinclair/typebox';

/**
 * Feature 19 audit contribution (FR-014, D-14). The authority records each event in the write transaction, with the
 * mutation ID as origin and the target's Visibility, so a hidden participant's label stays with GM readers. State
 * changes are feature 11's `effect.applied`.
 */
export interface EncounterAuditDeclaration {
  readonly action: string;
  readonly version: number;
  readonly payload?: TSchema;
  render(event: {
    readonly action: string;
    readonly targetType: string;
    readonly targetId: string;
    readonly before?: Record<string, unknown>;
    readonly after?: Record<string, unknown>;
    readonly at: string;
  }): { readonly text: string };
}

export const ENCOUNTER_AUDIT_ACTIONS = {
  started: 'encounter.started',
  ended: 'encounter.ended',
  participantAdded: 'encounter.participant_added',
  participantRemoved: 'encounter.participant_removed',
  participantRevealed: 'encounter.participant_revealed',
} as const;

export const EncounterAuditValue = Type.Object(
  {
    name: Type.Optional(Type.String({ maxLength: 120 })),
    encounterId: Type.Optional(Type.String({ maxLength: 64 })),
  },
  { additionalProperties: false },
);

function named(prefix: string, value: unknown, fallback: string): string {
  return typeof value === 'string' && value !== ''
    ? `${prefix} ${value}.`
    : `${prefix} ${fallback}.`;
}

export const ENCOUNTER_AUDIT_DECLARATIONS: readonly EncounterAuditDeclaration[] = [
  {
    action: ENCOUNTER_AUDIT_ACTIONS.started,
    version: 1,
    payload: EncounterAuditValue,
    render: ({ after }) => ({ text: named('Started the encounter', after?.name, 'an encounter') }),
  },
  {
    action: ENCOUNTER_AUDIT_ACTIONS.ended,
    version: 1,
    payload: EncounterAuditValue,
    render: ({ after }) => ({ text: named('Ended the encounter', after?.name, 'an encounter') }),
  },
  {
    action: ENCOUNTER_AUDIT_ACTIONS.participantAdded,
    version: 1,
    payload: EncounterAuditValue,
    render: ({ after }) => ({
      text: named('Added to the encounter:', after?.name, 'a participant'),
    }),
  },
  {
    action: ENCOUNTER_AUDIT_ACTIONS.participantRemoved,
    version: 1,
    payload: EncounterAuditValue,
    render: ({ before }) => ({
      text: named('Removed from the encounter:', before?.name, 'a participant'),
    }),
  },
  {
    action: ENCOUNTER_AUDIT_ACTIONS.participantRevealed,
    version: 1,
    payload: EncounterAuditValue,
    render: ({ after }) => ({
      text: named('Revealed in the encounter:', after?.name, 'a participant'),
    }),
  },
];
