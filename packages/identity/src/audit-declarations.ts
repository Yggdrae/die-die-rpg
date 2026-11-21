import { type TSchema, Type } from '@sinclair/typebox';

/**
 * Feature 01's audit contributions (feature 06 FR-005, FR-006): membership and role changes
 * recorded by `InvitationService` and `MembershipService`. Structural shape of feature 06's
 * `AuditEventDeclaration` (this package does not depend on `@rpg/audit`). The payload carries the
 * member's role and membership version only, never a username or credential.
 */
export interface MembershipAuditDeclaration {
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

export const MEMBERSHIP_AUDIT_ACTIONS = {
  created: 'membership.created',
  removed: 'membership.removed',
  roleChanged: 'membership.role_changed',
  ownershipTransferred: 'membership.ownership_transferred',
} as const;

const Payload = Type.Object({
  role: Type.Optional(Type.String()),
  version: Type.Optional(Type.Integer()),
  removed: Type.Optional(Type.Boolean()),
});

const ROLE_NAMES: Readonly<Record<string, string>> = {
  owner: 'owner',
  gm: 'GM',
  assistant_gm: 'assistant GM',
  player: 'player',
  observer: 'observer',
};

function role(after: Record<string, unknown> | undefined): string | undefined {
  return typeof after?.role === 'string' ? ROLE_NAMES[after.role] : undefined;
}

export const MEMBERSHIP_AUDIT_DECLARATIONS: readonly MembershipAuditDeclaration[] = [
  {
    action: MEMBERSHIP_AUDIT_ACTIONS.created,
    version: 1,
    payload: Payload,
    render: ({ after }) => {
      const name = role(after);
      return { text: name === undefined ? 'A member joined.' : `A member joined as ${name}.` };
    },
  },
  {
    action: MEMBERSHIP_AUDIT_ACTIONS.removed,
    version: 1,
    payload: Payload,
    render: () => ({ text: 'Removed a member from the campaign.' }),
  },
  {
    action: MEMBERSHIP_AUDIT_ACTIONS.roleChanged,
    version: 1,
    payload: Payload,
    render: ({ after }) => {
      const name = role(after);
      return {
        text:
          name === undefined ? "Changed a member's role." : `Changed a member's role to ${name}.`,
      };
    },
  },
  {
    action: MEMBERSHIP_AUDIT_ACTIONS.ownershipTransferred,
    version: 1,
    payload: Payload,
    render: ({ after }) => {
      const name = role(after);
      return {
        text:
          name === undefined
            ? 'Transferred campaign ownership.'
            : `Transferred campaign ownership; this member is now ${name}.`,
      };
    },
  },
];
