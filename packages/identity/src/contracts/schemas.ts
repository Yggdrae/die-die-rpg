import { Id, Timestamp, Version } from '@rpg/contracts';
import { type Static, type TSchema, Type } from '@sinclair/typebox';

export const UsernameInput = Type.String({ minLength: 3, maxLength: 64, $id: 'UsernameInput' });
export type UsernameInput = Static<typeof UsernameInput>;

/** Secret input only. The pattern counts a surrogate pair as one Unicode code point. */
export const PasswordInput = Type.String({
  minLength: 15,
  maxLength: 512,
  pattern: '^(?:[\\uD800-\\uDBFF][\\uDC00-\\uDFFF]|[\\s\\S]){15,128}$',
  $id: 'PasswordInput',
});
export type PasswordInput = Static<typeof PasswordInput>;

export const OpaqueCredential = Type.String({
  minLength: 43,
  maxLength: 43,
  pattern: '^[A-Za-z0-9_-]{43}$',
});

export const MvpRole = Type.Union(
  [Type.Literal('owner'), Type.Literal('gm'), Type.Literal('assistant_gm'), Type.Literal('player')],
  { $id: 'IdentityMvpRole' },
);
export type MvpRole = Static<typeof MvpRole>;

export const AssignableRole = Type.Union(
  [Type.Literal('gm'), Type.Literal('assistant_gm'), Type.Literal('player')],
  { $id: 'IdentityAssignableRole' },
);
export type AssignableRole = Static<typeof AssignableRole>;

export const AccountCreateInput = Type.Object(
  { username: UsernameInput, password: PasswordInput },
  { additionalProperties: false, $id: 'AccountCreateInput' },
);
export type AccountCreateInput = Static<typeof AccountCreateInput>;

export const SessionCreateInput = Type.Object(
  { username: UsernameInput, password: PasswordInput },
  { additionalProperties: false, $id: 'SessionCreateInput' },
);
export type SessionCreateInput = Static<typeof SessionCreateInput>;

export const RecoveryConsumeInput = Type.Object(
  { token: OpaqueCredential, newPassword: PasswordInput },
  { additionalProperties: false, $id: 'RecoveryConsumeInput' },
);
export type RecoveryConsumeInput = Static<typeof RecoveryConsumeInput>;

export const InvitationCredentialInput = Type.Object(
  { token: OpaqueCredential },
  { additionalProperties: false, $id: 'InvitationCredentialInput' },
);
export type InvitationCredentialInput = Static<typeof InvitationCredentialInput>;

export const UserSummary = Type.Object(
  { id: Id, username: Type.String({ minLength: 3, maxLength: 32 }) },
  { additionalProperties: false, $id: 'UserSummary' },
);
export type UserSummary = Static<typeof UserSummary>;

export const SessionSummary = Type.Object(
  {
    id: Id,
    createdAt: Timestamp,
    expiresAt: Timestamp,
    lastSeenAt: Type.Optional(Timestamp),
    current: Type.Boolean(),
  },
  { additionalProperties: false, $id: 'SessionSummary' },
);
export type SessionSummary = Static<typeof SessionSummary>;

export const AccountSessionView = Type.Object(
  { user: UserSummary, session: SessionSummary },
  { additionalProperties: false, $id: 'AccountSessionView' },
);
export type AccountSessionView = Static<typeof AccountSessionView>;

export const MembershipView = Type.Object(
  {
    user: UserSummary,
    campaignId: Id,
    role: MvpRole,
    version: Version,
    updatedAt: Timestamp,
  },
  { additionalProperties: false, $id: 'MembershipView' },
);
export type MembershipView = Static<typeof MembershipView>;

export const InvitationCreateInput = Type.Object(
  {
    targetRole: AssignableRole,
    expiresInSeconds: Type.Optional(Type.Integer({ minimum: 5 * 60, maximum: 30 * 24 * 60 * 60 })),
  },
  { additionalProperties: false, $id: 'InvitationCreateInput' },
);
export type InvitationCreateInput = Static<typeof InvitationCreateInput>;

export const InvitationState = Type.Union([
  Type.Literal('usable'),
  Type.Literal('used'),
  Type.Literal('revoked'),
  Type.Literal('expired'),
]);
export type InvitationState = Static<typeof InvitationState>;

export const InvitationView = Type.Object(
  {
    id: Id,
    campaignId: Id,
    targetRole: AssignableRole,
    expiresAt: Timestamp,
    state: InvitationState,
  },
  { additionalProperties: false, $id: 'InvitationView' },
);
export type InvitationView = Static<typeof InvitationView>;

/** Raw token appears only in this one-time issuance response. No stored digest is serialized. */
export const InvitationIssuedView = Type.Object(
  { invitation: InvitationView, token: OpaqueCredential },
  { additionalProperties: false, $id: 'InvitationIssuedView' },
);
export type InvitationIssuedView = Static<typeof InvitationIssuedView>;

export const InvitationPreview = Type.Object(
  {
    campaignDisplayName: Type.String({ minLength: 1 }),
    targetRole: AssignableRole,
    expiresAt: Timestamp,
  },
  { additionalProperties: false, $id: 'InvitationPreview' },
);
export type InvitationPreview = Static<typeof InvitationPreview>;

export const RoleChangeInput = Type.Object(
  { role: AssignableRole },
  { additionalProperties: false, $id: 'RoleChangeInput' },
);
export type RoleChangeInput = Static<typeof RoleChangeInput>;

export const OwnershipTransferInput = Type.Object(
  { targetUserId: Id },
  { additionalProperties: false, $id: 'OwnershipTransferInput' },
);
export type OwnershipTransferInput = Static<typeof OwnershipTransferInput>;

export const PaginationInput = Type.Object(
  {
    cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 50 })),
  },
  { additionalProperties: false, $id: 'IdentityPaginationInput' },
);
export type PaginationInput = Static<typeof PaginationInput>;

export function Page<T extends TSchema>(item: T) {
  return Type.Object(
    {
      items: Type.Array(item),
      nextCursor: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    },
    { additionalProperties: false },
  );
}

export const MembershipPage = Page(MembershipView);
export type MembershipPage = Static<typeof MembershipPage>;

export const SessionPage = Page(SessionSummary);
export type SessionPage = Static<typeof SessionPage>;
