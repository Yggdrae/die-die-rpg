import {
  ACTIONS_SYNC_FEATURE_ID,
  EFFECT_REPLICA_TABLE,
  EFFECT_ROW_CODEC,
  EffectLocalRepository,
  type EffectRecord,
} from '@rpg/actions';
import type { BrowserSyncSession } from '@rpg/sync/browser';

/**
 * Feature 11 device composition, what features 15, 18, and 19 apply effects through. Over the browser
 * replica. Planning is pure and needs no composition (`@rpg/actions`). Rolling is feature 09's.
 */
export function browserEffectRepository(
  session: BrowserSyncSession,
  input: { readonly userId: string; readonly campaignId: string },
): EffectLocalRepository {
  return new EffectLocalRepository(
    session.repository<EffectRecord>({
      tableName: EFFECT_REPLICA_TABLE,
      featureId: ACTIONS_SYNC_FEATURE_ID,
      campaignId: input.campaignId,
      codec: EFFECT_ROW_CODEC,
      // The authority records the audit event itself, once, by the application's id (D-19).
      audited: false,
    }),
    input,
  );
}
