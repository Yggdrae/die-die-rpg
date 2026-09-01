import { err, ok, type Result, type Role } from '@rpg/contracts';
import type {
  InvitationIssuedView,
  InvitationPreview,
  InvitationView,
  MembershipView,
} from '../contracts/schemas.ts';
import { isInvitationRole } from '../domain/roles.ts';
import { digestOpaqueCredential, generateOpaqueCredential } from '../infra/credentials.ts';

export type InvitationError =
  | 'invalid_role'
  | 'invalid_lifetime'
  | 'not_found_or_forbidden'
  | 'unusable_invitation'
  | 'membership_already_exists'
  | 'identity_unavailable';

export interface InvitationRecord {
  readonly id: string;
  readonly campaignId: string;
  readonly campaignDisplayName: string;
  readonly targetRole: Role;
  readonly expiresAt: Date;
  readonly state: 'usable' | 'used' | 'revoked' | 'expired';
}

export interface InvitationStore {
  issue(input: {
    readonly id: string;
    readonly campaignId: string;
    readonly actorUserId: string;
    readonly targetRole: 'gm' | 'assistant_gm' | 'player';
    readonly tokenDigest: Uint8Array;
    readonly expiresInSeconds: number;
  }): Promise<Result<InvitationRecord, InvitationError>>;
  preview(tokenDigest: Uint8Array): Promise<InvitationRecord | undefined>;
  accept(input: {
    readonly tokenDigest: Uint8Array;
    readonly userId: string;
  }): Promise<Result<MembershipView, InvitationError>>;
  revoke(input: {
    readonly invitationId: string;
    readonly campaignId: string;
    readonly actorUserId: string;
  }): Promise<Result<void, InvitationError>>;
  list(input: {
    readonly campaignId: string;
    readonly actorUserId: string;
  }): Promise<Result<readonly InvitationRecord[], InvitationError>>;
}

export class InvitationService {
  constructor(private readonly store: InvitationStore) {}

  async issue(
    actorUserId: string,
    campaignId: string,
    input: { readonly targetRole: Role; readonly expiresInSeconds?: number },
  ): Promise<Result<InvitationIssuedView, InvitationError>> {
    if (!isInvitationRole(input.targetRole)) return err('invalid_role');
    const expiresInSeconds = input.expiresInSeconds ?? 7 * 24 * 60 * 60;
    if (expiresInSeconds < 5 * 60 || expiresInSeconds > 30 * 24 * 60 * 60) {
      return err('invalid_lifetime');
    }
    const token = generateOpaqueCredential();
    const issued = await this.store.issue({
      id: crypto.randomUUID(),
      campaignId,
      actorUserId,
      targetRole: input.targetRole,
      tokenDigest: await digestOpaqueCredential(token),
      expiresInSeconds,
    });
    if (!issued.ok) return issued;
    return ok({ invitation: toView(issued.value), token });
  }

  async preview(token: string): Promise<Result<InvitationPreview, 'unusable_invitation'>> {
    if (!isOpaque(token)) return err('unusable_invitation');
    const record = await this.store.preview(await digestOpaqueCredential(token));
    if (record === undefined || record.state !== 'usable' || !isInvitationRole(record.targetRole)) {
      return err('unusable_invitation');
    }
    return ok({
      campaignDisplayName: record.campaignDisplayName,
      targetRole: record.targetRole,
      expiresAt: record.expiresAt.toISOString(),
    });
  }

  async accept(userId: string, token: string): Promise<Result<MembershipView, InvitationError>> {
    if (!isOpaque(token)) return err('unusable_invitation');
    return this.store.accept({ tokenDigest: await digestOpaqueCredential(token), userId });
  }

  revoke(actorUserId: string, campaignId: string, invitationId: string) {
    return this.store.revoke({ actorUserId, campaignId, invitationId });
  }

  async list(
    actorUserId: string,
    campaignId: string,
  ): Promise<Result<readonly InvitationView[], InvitationError>> {
    const result = await this.store.list({ actorUserId, campaignId });
    return result.ok ? ok(result.value.map(toView)) : result;
  }
}

function isOpaque(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value);
}

function toView(record: InvitationRecord): InvitationView {
  if (!isInvitationRole(record.targetRole)) throw new Error('invalid persisted invitation role');
  return {
    id: record.id,
    campaignId: record.campaignId,
    targetRole: record.targetRole,
    expiresAt: record.expiresAt.toISOString(),
    state: record.state,
  };
}
