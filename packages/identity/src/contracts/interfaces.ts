import type { ActorRef, Id, Result } from '@rpg/contracts';

export interface AuthenticatedUser {
  readonly userId: Id;
  readonly sessionId: Id;
}

export interface ActorResolver {
  resolve(userId: Id, campaignId: Id): Promise<Result<ActorRef, 'membership_not_found'>>;
}

export type MembershipError = 'membership_already_exists' | 'campaign_not_found' | 'owner_conflict';

export interface CampaignMembershipTransaction {
  /** Opaque transaction handle. Only the identity infrastructure adapter may inspect it. */
  readonly handle: unknown;
}

/**
 * Feature 02's narrow integration boundary for its campaign-creation transaction.
 * General membership assignment is intentionally unavailable.
 */
export interface CampaignMembershipWriter {
  createOwner(
    input: {
      readonly userId: Id;
      readonly campaignId: Id;
    },
    transaction: CampaignMembershipTransaction,
  ): Promise<Result<ActorRef, MembershipError>>;
}
