import type { ActorRef, Id, Result } from '@rpg/contracts';

export interface AuthenticatedUser {
  readonly userId: Id;
  readonly sessionId: Id;
}

export interface ActorResolver {
  resolve(userId: Id, campaignId: Id): Promise<Result<ActorRef, 'membership_not_found'>>;
}

export type MembershipError = 'membership_already_exists' | 'campaign_not_found' | 'owner_conflict';

/**
 * Feature 02's narrow integration boundary for its campaign-creation transaction.
 * General membership assignment is intentionally unavailable.
 */
export interface CampaignMembershipWriter {
  createOwner(input: {
    readonly userId: Id;
    readonly campaignId: Id;
  }): Promise<Result<ActorRef, MembershipError>>;
}
