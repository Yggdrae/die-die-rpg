import { CAMPAIGN_PIN_REPLICA_TABLE, campaignReplicaSystem } from '@rpg/campaigns/export';
import type { SystemRef } from '@rpg/contracts';
import {
  RULES_MARK_REPLICA_TABLE,
  RULES_MARK_ROW_CODEC,
  RULES_SYNC_FEATURE_ID,
  type RulesLibraryModel,
  RulesMarkLocalRepository,
  type RulesMarkRecord,
  rulesLibrary,
} from '@rpg/rules';
import type { BrowserSyncSession } from '@rpg/sync/browser';
import type { SystemPackage } from '@rpg/systems';

/**
 * Feature 14 device composition (`_techspec.md` D-02, D-13): the campaign's pinned rules come from the replicated pin
 * and the installed packages in the application bundle, so the library works offline whenever the app does. The
 * user's marks are a feature 03 repository over the browser replica. The shell supplies `resolve`; nothing here
 * imports another web feature. Tests build their own `RulesSource`.
 */

export type PinnedRules =
  | { readonly status: 'waiting' }
  | { readonly status: 'not_installed'; readonly ref: SystemRef }
  | { readonly status: 'ready'; readonly library: RulesLibraryModel };

export interface RulesSource {
  readonly userId: string;
  readonly campaignId: string;
  /** The campaign's pinned rules: never another version (FR-011). */
  pinned(): Promise<PinnedRules>;
  readonly marks: RulesMarkLocalRepository;
  subscribe(listener: () => void): () => void;
}

const WATCHED = [RULES_MARK_REPLICA_TABLE, CAMPAIGN_PIN_REPLICA_TABLE, 'sync_pending_mutations'];

export function browserRulesSource(
  session: BrowserSyncSession,
  input: {
    readonly userId: string;
    readonly campaignId: string;
    readonly resolve: (ref: SystemRef) => SystemPackage | undefined;
  },
): RulesSource {
  const records = session.repository<RulesMarkRecord>({
    tableName: RULES_MARK_REPLICA_TABLE,
    featureId: RULES_SYNC_FEATURE_ID,
    campaignId: input.campaignId,
    codec: RULES_MARK_ROW_CODEC,
    // Marks are never audited (D-10).
    audited: false,
  });
  let cached: { readonly key: string; readonly library: RulesLibraryModel } | undefined;
  return {
    userId: input.userId,
    campaignId: input.campaignId,
    marks: new RulesMarkLocalRepository(records, input),
    async pinned() {
      const ref = await campaignReplicaSystem(session.database, input.campaignId);
      if (ref === undefined) return { status: 'waiting' };
      const key = `${ref.systemId}@${ref.version}`;
      if (cached?.key !== key) {
        const system = input.resolve(ref);
        if (system === undefined) return { status: 'not_installed', ref };
        cached = { key, library: rulesLibrary(system) };
      }
      return { status: 'ready', library: cached.library };
    },
    subscribe(listener) {
      return session.database.onChange(
        { onChange: () => listener() },
        { tables: WATCHED, throttleMs: 50 },
      );
    },
  };
}
