import { describe, expect, test } from 'bun:test';
import { Value } from '@sinclair/typebox/value';

import {
  AccountCreateInput,
  AccountSessionView,
  InvitationCreateInput,
  InvitationIssuedView,
  InvitationPreview,
  MembershipView,
  PaginationInput,
  RecoveryConsumeInput,
  RoleChangeInput,
} from './schemas.ts';

const USER_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const CAMPAIGN_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3302';
const INVITATION_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3303';
const CREATED_AT = '2026-08-27T14:00:00Z';
const EXPIRES_AT = '2026-09-03T14:00:00Z';

describe('secret-bearing inputs', () => {
  test('accepts account and recovery credentials only in their input schemas', () => {
    expect(
      Value.Check(AccountCreateInput, { username: 'table_gm', password: 'fifteen-chars-ok' }),
    ).toBe(true);
    expect(
      Value.Check(RecoveryConsumeInput, {
        token: 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde',
        newPassword: 'replacement-password',
      }),
    ).toBe(true);
  });

  test('enforces password code-point boundaries without trimming', () => {
    expect(
      Value.Check(AccountCreateInput, { username: 'table_gm', password: 'x'.repeat(14) }),
    ).toBe(false);
    expect(
      Value.Check(AccountCreateInput, { username: 'table_gm', password: ` ${'x'.repeat(14)}` }),
    ).toBe(true);
    expect(
      Value.Check(AccountCreateInput, { username: 'table_gm', password: '😀'.repeat(128) }),
    ).toBe(true);
    expect(
      Value.Check(AccountCreateInput, { username: 'table_gm', password: 'x'.repeat(129) }),
    ).toBe(false);
  });

  test.each(['password', 'passwordHash', 'credential', 'token', 'tokenDigest'])(
    'account/session response rejects secret field %s',
    (field) => {
      expect(
        Value.Check(AccountSessionView, {
          user: { id: USER_ID, username: 'table_gm' },
          session: {
            id: INVITATION_ID,
            createdAt: CREATED_AT,
            expiresAt: EXPIRES_AT,
            current: true,
          },
          [field]: 'secret',
        }),
      ).toBe(false);
    },
  );
});

describe('membership and invitation schemas', () => {
  test.each(['owner', 'gm', 'assistant_gm', 'player'])('reads MVP membership role %s', (role) => {
    expect(
      Value.Check(MembershipView, {
        user: { id: USER_ID, username: 'table_gm' },
        campaignId: CAMPAIGN_ID,
        role,
        version: 1,
        updatedAt: CREATED_AT,
      }),
    ).toBe(true);
  });

  test('rejects reserved observer on membership reads and ordinary writes', () => {
    expect(
      Value.Check(MembershipView, {
        user: { id: USER_ID, username: 'table_gm' },
        campaignId: CAMPAIGN_ID,
        role: 'observer',
        version: 1,
        updatedAt: CREATED_AT,
      }),
    ).toBe(false);
    expect(Value.Check(InvitationCreateInput, { targetRole: 'observer' })).toBe(false);
    expect(Value.Check(RoleChangeInput, { role: 'observer' })).toBe(false);
  });

  test('rejects owner on invitation and ordinary role writes', () => {
    expect(Value.Check(InvitationCreateInput, { targetRole: 'owner' })).toBe(false);
    expect(Value.Check(RoleChangeInput, { role: 'owner' })).toBe(false);
  });

  test('one-time invitation issuance exposes no stored digest', () => {
    const valid = {
      invitation: {
        id: INVITATION_ID,
        campaignId: CAMPAIGN_ID,
        targetRole: 'player',
        expiresAt: EXPIRES_AT,
        state: 'usable',
      },
      token: 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde',
    };
    expect(Value.Check(InvitationIssuedView, valid)).toBe(true);
    expect(Value.Check(InvitationIssuedView, { ...valid, tokenDigest: 'stored-secret' })).toBe(
      false,
    );
  });

  test('public preview contains only approved fields', () => {
    const valid = {
      campaignDisplayName: 'The Long Road',
      targetRole: 'player',
      expiresAt: EXPIRES_AT,
    };
    expect(Value.Check(InvitationPreview, valid)).toBe(true);
    expect(Value.Check(InvitationPreview, { ...valid, campaignId: CAMPAIGN_ID })).toBe(false);
    expect(Value.Check(InvitationPreview, { ...valid, inviterId: USER_ID })).toBe(false);
  });
});

describe('pagination', () => {
  test.each([{}, { limit: 1 }, { limit: 100 }, { cursor: 'opaque', limit: 50 }])(
    'accepts %j',
    (value) => {
      expect(Value.Check(PaginationInput, value)).toBe(true);
    },
  );

  test.each([{ limit: 0 }, { limit: 101 }, { cursor: '' }])('rejects %j', (value) => {
    expect(Value.Check(PaginationInput, value)).toBe(false);
  });
});
