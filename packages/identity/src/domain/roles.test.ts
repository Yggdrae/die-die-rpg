import { describe, expect, test } from 'bun:test';
import type { Role } from '@rpg/contracts';

import {
  decideOwnershipTransfer,
  decideRemoval,
  decideRoleChange,
  isInvitationRole,
  isMvpRole,
  isOrdinaryRoleChange,
} from './roles.ts';

describe('role validation', () => {
  test.each(['owner', 'gm', 'assistant_gm', 'player'] satisfies Role[])(
    '%s is an MVP role',
    (role) => {
      expect(isMvpRole(role)).toBe(true);
    },
  );

  test('reserved observer cannot be read as an MVP membership', () => {
    expect(isMvpRole('observer')).toBe(false);
  });

  test.each(['gm', 'assistant_gm', 'player'] satisfies Role[])('%s is assignable', (role) => {
    expect(isInvitationRole(role)).toBe(true);
    expect(isOrdinaryRoleChange(role)).toBe(true);
  });

  test.each(['owner', 'observer'] satisfies Role[])('%s is not assignable', (role) => {
    expect(isInvitationRole(role)).toBe(false);
    expect(isOrdinaryRoleChange(role)).toBe(false);
  });
});

describe('membership removal', () => {
  test.each([
    ['owner', 'gm'],
    ['owner', 'assistant_gm'],
    ['owner', 'player'],
    ['gm', 'assistant_gm'],
    ['gm', 'player'],
  ] as const)('%s can remove %s', (actor, target) => {
    expect(decideRemoval(actor, target, false)).toEqual({ allowed: true });
  });

  test('a GM can remove themselves', () => {
    expect(decideRemoval('gm', 'gm', true)).toEqual({ allowed: true });
  });

  test('a GM cannot remove another GM', () => {
    expect(decideRemoval('gm', 'gm', false)).toEqual({
      allowed: false,
      reason: 'insufficient_authority',
    });
  });

  test.each(['owner', 'gm', 'assistant_gm', 'player'] as const)(
    '%s cannot remove the owner',
    (actor) => {
      expect(decideRemoval(actor, 'owner', actor === 'owner')).toEqual({
        allowed: false,
        reason: 'owner_cannot_be_removed',
      });
    },
  );

  test.each(['assistant_gm', 'player'] as const)('%s cannot remove a player', (actor) => {
    expect(decideRemoval(actor, 'player', false)).toEqual({
      allowed: false,
      reason: 'insufficient_authority',
    });
  });
});

describe('role change and ownership transfer', () => {
  test.each(['gm', 'assistant_gm', 'player'] as const)(
    'owner can change a non-owner role currently set to %s',
    (target) => {
      expect(decideRoleChange('owner', target)).toEqual({ allowed: true });
    },
  );

  test('non-owner cannot change a role', () => {
    expect(decideRoleChange('gm', 'player')).toEqual({
      allowed: false,
      reason: 'insufficient_authority',
    });
  });

  test('ordinary role change cannot target an owner', () => {
    expect(decideRoleChange('owner', 'owner')).toEqual({
      allowed: false,
      reason: 'target_is_owner',
    });
  });

  test('owner can transfer to a current non-owner member and becomes GM', () => {
    expect(decideOwnershipTransfer('owner', 'player')).toEqual({
      allowed: true,
      formerOwnerRole: 'gm',
    });
  });

  test('non-owner cannot transfer ownership', () => {
    expect(decideOwnershipTransfer('gm', 'player')).toEqual({
      allowed: false,
      reason: 'insufficient_authority',
    });
  });

  test('ownership target must be a current member', () => {
    expect(decideOwnershipTransfer('owner', undefined)).toEqual({
      allowed: false,
      reason: 'target_not_current_member',
    });
  });
});
