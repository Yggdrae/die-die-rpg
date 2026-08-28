import type { Role } from '@rpg/contracts';
import type { AssignableRole, MvpRole } from '../contracts/schemas.ts';

const MVP_ROLES: readonly Role[] = ['owner', 'gm', 'assistant_gm', 'player'];
const ASSIGNABLE_ROLES: readonly Role[] = ['gm', 'assistant_gm', 'player'];

export function isMvpRole(role: Role): role is MvpRole {
  return MVP_ROLES.includes(role);
}

export function isInvitationRole(role: Role): role is AssignableRole {
  return ASSIGNABLE_ROLES.includes(role);
}

export const isOrdinaryRoleChange = isInvitationRole;

export type RemovalDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly reason: 'owner_cannot_be_removed' | 'insufficient_authority';
    };

export function decideRemoval(
  actorRole: MvpRole,
  targetRole: MvpRole,
  removingSelf: boolean,
): RemovalDecision {
  if (targetRole === 'owner') {
    return { allowed: false, reason: 'owner_cannot_be_removed' };
  }
  if (actorRole === 'owner') {
    return { allowed: true };
  }
  if (
    actorRole === 'gm' &&
    ((removingSelf && targetRole === 'gm') ||
      targetRole === 'assistant_gm' ||
      targetRole === 'player')
  ) {
    return { allowed: true };
  }
  return { allowed: false, reason: 'insufficient_authority' };
}

export type RoleChangeDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: 'target_is_owner' | 'insufficient_authority' };

export function decideRoleChange(actorRole: MvpRole, targetRole: MvpRole): RoleChangeDecision {
  if (targetRole === 'owner') {
    return { allowed: false, reason: 'target_is_owner' };
  }
  return actorRole === 'owner'
    ? { allowed: true }
    : { allowed: false, reason: 'insufficient_authority' };
}

export type OwnershipTransferDecision =
  | { readonly allowed: true; readonly formerOwnerRole: 'gm' }
  | {
      readonly allowed: false;
      readonly reason: 'insufficient_authority' | 'target_not_current_member' | 'target_is_owner';
    };

export function decideOwnershipTransfer(
  actorRole: MvpRole,
  targetRole: MvpRole | undefined,
): OwnershipTransferDecision {
  if (actorRole !== 'owner') {
    return { allowed: false, reason: 'insufficient_authority' };
  }
  if (targetRole === undefined) {
    return { allowed: false, reason: 'target_not_current_member' };
  }
  if (targetRole === 'owner') {
    return { allowed: false, reason: 'target_is_owner' };
  }
  return { allowed: true, formerOwnerRole: 'gm' };
}
