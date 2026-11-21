import { AuthorizationService, ResourcePolicyRegistry } from '@rpg/authorization';
import type { Role } from '@rpg/contracts';
import {
  DICE_ROLL_POLICY,
  DICE_ROLL_REPLICA_TABLE,
  DICE_SYNC_FEATURE_ID,
  mayCreateRoll,
  ROLL_ROW_CODEC,
  RollLocalRepository,
  type RollRecord,
} from '@rpg/dice';
import type { BrowserSyncSession } from '@rpg/sync/browser';

/**
 * Feature 09 device composition, what features 11, 15, 18, and 19 roll through. Over the browser
 * replica, with no audit envelope (D-08). The cached membership answers the D-12 question through the
 * same feature 04 decision the authority applies; no membership means no roll.
 */

function rollDecider() {
  const policies = new ResourcePolicyRegistry();
  policies.register(DICE_ROLL_POLICY);
  return new AuthorizationService(policies);
}

export function browserRollRepository(
  session: BrowserSyncSession,
  input: { readonly userId: string; readonly campaignId: string },
): RollLocalRepository {
  const decider = rollDecider();
  const records = session.repository<RollRecord>({
    tableName: DICE_ROLL_REPLICA_TABLE,
    featureId: DICE_SYNC_FEATURE_ID,
    campaignId: input.campaignId,
    codec: ROLL_ROW_CODEC,
    audited: false,
  });
  return new RollLocalRepository(records, input, async (roll) => {
    const cached = await session.store.cachedMembership(input.campaignId);
    if (cached === undefined || cached.removedAt !== null) return false;
    return mayCreateRoll(
      decider,
      { userId: input.userId, campaignId: input.campaignId, role: cached.role as Role },
      { campaignId: input.campaignId, ...roll },
    );
  });
}
