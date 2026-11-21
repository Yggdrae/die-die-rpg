import type { AuditEventDeclaration } from '@rpg/audit';
import { check, Visibility } from '@rpg/contracts';
import { VISIBILITY_AUDIT_ACTIONS } from './visibility.ts';

/**
 * Feature 04's audit contributions (feature 06 FR-005, FR-006): Visibility reveal and un-reveal,
 * recorded by `VisibilityService` with `{ visibility, version }` before and after. The text names
 * the resource class and how many players a change reached; recipients' IDs are not rendered.
 */
function describe(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const visibility = (value as { visibility?: unknown }).visibility;
  if (!check(Visibility, visibility)) return undefined;
  switch (visibility.mode) {
    case 'everyone':
      return 'everyone';
    case 'gm_only':
      return 'GM roles only';
    case 'players':
      return visibility.playerIds.length === 1
        ? '1 player'
        : `${visibility.playerIds.length} players`;
    case 'party':
      return visibility.partyIds.length === 1 ? '1 party' : `${visibility.partyIds.length} parties`;
  }
}

const RESOURCE = /^[a-z][a-z0-9_.-]{0,63}$/;

function resource(targetType: string): string {
  return RESOURCE.test(targetType) ? targetType : 'a record';
}

export const VISIBILITY_AUDIT_DECLARATIONS: readonly AuditEventDeclaration[] = [
  {
    action: VISIBILITY_AUDIT_ACTIONS.reveal,
    version: 1,
    render: ({ targetType, after }) => {
      const to = describe(after);
      return {
        text:
          to === undefined
            ? `Revealed ${resource(targetType)}.`
            : `Revealed ${resource(targetType)} to ${to}.`,
      };
    },
  },
  {
    action: VISIBILITY_AUDIT_ACTIONS.unreveal,
    version: 1,
    render: ({ targetType, after }) => {
      const to = describe(after);
      return {
        text:
          to === undefined
            ? `Hid ${resource(targetType)} again.`
            : `Hid ${resource(targetType)} again; now visible to ${to}.`,
      };
    },
  },
];
