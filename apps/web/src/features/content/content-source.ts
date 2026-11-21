import {
  CONTENT_REPLICA_TABLES,
  CONTENT_SYNC_FEATURE_ID,
  ENTITY_REPLICA_TABLE,
  ENTITY_ROW_CODEC,
  EntityLocalRepository,
  type EntityRecord,
  PERSONAL_NOTE_REPLICA_TABLE,
  PERSONAL_NOTE_ROW_CODEC,
  PersonalNoteLocalRepository,
  type PersonalNoteRecord,
  RELATIONSHIP_REPLICA_TABLE,
  RELATIONSHIP_ROW_CODEC,
  RelationshipLocalRepository,
  type RelationshipRecord,
} from '@rpg/content';
import type { SyncedRepository } from '@rpg/contracts';
import type { MutationConflict, MutationState } from '@rpg/sync';
import type { BrowserSyncedRepository, BrowserSyncSession } from '@rpg/sync/browser';
import type { ContentDraftStore } from './draft-store.ts';
import { type HoldApi, type HoldField, httpHoldApi } from './hold-api.ts';

/**
 * What the feature 16 screens read and write: the device repositories over the local replica
 * (`@rpg/content` `offline.ts`), the cached membership role (an affordance hint only), the
 * feature 03 conflict queue, replicated holds, the hold routes, and the D-17 draft store.
 * Production builds it over the browser replica (`browserContentSource`); tests build it over
 * the `SyncedRepository` double.
 */
export interface ContentSource {
  readonly campaignId: string;
  readonly userId: string;
  readonly entities: EntityLocalRepository;
  /** Raw entity rows (tombstones included) for broken-link rendering. */
  readonly entityRecords: SyncedRepository<EntityRecord>;
  readonly notes: PersonalNoteLocalRepository;
  readonly relationships: RelationshipLocalRepository;
  readonly drafts: ContentDraftStore;
  readonly holds: HoldApi;
  /** The cached membership role for this campaign (hint; the authority decides). */
  role(): Promise<string | undefined>;
  /** Replica, queue, conflict, hold, or membership changes. Returns an unsubscribe. */
  subscribe(listener: () => void): () => void;
  conflicts(): Promise<readonly MutationConflict[]>;
  resolveConflict(conflict: MutationConflict, choice: 'keep_authority' | 'resubmit'): Promise<void>;
  deferConflict(conflict: MutationConflict): Promise<void>;
  /** The replicated hold on a field (holder and version), when the replica holds it. */
  replicatedHold(field: HoldField): Promise<{ readonly version: number } | undefined>;
  /**
   * After a held long-text save: keeps the hold until the queued write has left the device
   * (the authority checks the hold when the write arrives, B-2), then releases it. Resolves
   * `accepted`, or `failed` when the write was rejected or conflicted (the draft is kept).
   */
  settleHeldWrite(field: HoldField, holdVersion: number): Promise<'accepted' | 'failed'>;
  /** Feature 17: the newest queued write of a record on this device, if any. */
  mutationState?(recordId: string): Promise<MutationState | undefined>;
}

/** Tables whose changes refresh the content screens. */
const WATCHED = [
  ...Object.keys(CONTENT_REPLICA_TABLES),
  'sync_long_text_holds',
  'sync_conflicts',
  'sync_pending_mutations',
  'sync_membership_cache',
];

export function browserContentSource(
  session: BrowserSyncSession,
  input: {
    readonly userId: string;
    readonly campaignId: string;
    readonly drafts: ContentDraftStore;
    readonly holds?: HoldApi;
  },
): ContentSource {
  const { userId, campaignId } = input;
  const entityRecords = session.repository<EntityRecord>({
    tableName: ENTITY_REPLICA_TABLE,
    featureId: CONTENT_SYNC_FEATURE_ID,
    campaignId,
    codec: ENTITY_ROW_CODEC,
  });
  const noteRecords = session.repository<PersonalNoteRecord>({
    tableName: PERSONAL_NOTE_REPLICA_TABLE,
    featureId: CONTENT_SYNC_FEATURE_ID,
    campaignId,
    codec: PERSONAL_NOTE_ROW_CODEC,
  });
  const linkRecords = session.repository<RelationshipRecord>({
    tableName: RELATIONSHIP_REPLICA_TABLE,
    featureId: CONTENT_SYNC_FEATURE_ID,
    campaignId,
    codec: RELATIONSHIP_ROW_CODEC,
  });
  const actor = { userId, campaignId };
  const entities = new EntityLocalRepository(entityRecords, actor, {
    // Feature 17 D-03: reveal and un-reveal carry no envelope; feature 04 audits them.
    visibilityRecords: session.repository<EntityRecord>({
      tableName: ENTITY_REPLICA_TABLE,
      featureId: CONTENT_SYNC_FEATURE_ID,
      campaignId,
      codec: ENTITY_ROW_CODEC,
      audited: false,
    }),
  });
  const byTable = new Map<
    string,
    Pick<BrowserSyncedRepository<EntityRecord>, 'resolveConflict' | 'deferConflict'>
  >([
    [ENTITY_REPLICA_TABLE, entityRecords],
    [PERSONAL_NOTE_REPLICA_TABLE, noteRecords],
    [RELATIONSHIP_REPLICA_TABLE, linkRecords],
  ]);
  const tables = new Set(byTable.keys());
  const holds = input.holds ?? httpHoldApi();
  return {
    campaignId,
    userId,
    entities,
    entityRecords,
    notes: new PersonalNoteLocalRepository(noteRecords, actor),
    relationships: new RelationshipLocalRepository(linkRecords, entities, actor),
    drafts: input.drafts,
    holds,
    async role() {
      const cached = await session.store.cachedMembership(campaignId);
      return cached === undefined || cached.removedAt !== null ? undefined : cached.role;
    },
    subscribe(listener) {
      return session.database.onChange(
        { onChange: () => listener() },
        { tables: WATCHED, throttleMs: 50 },
      );
    },
    async conflicts() {
      return (await session.store.conflicts(campaignId)).filter((conflict) =>
        tables.has(conflict.table),
      );
    },
    async resolveConflict(conflict, choice) {
      await byTable.get(conflict.table)?.resolveConflict(conflict.conflictId, choice);
    },
    async deferConflict(conflict) {
      await byTable.get(conflict.table)?.deferConflict(conflict.conflictId);
    },
    mutationState(recordId) {
      return session.store.latestMutationState(campaignId, recordId);
    },
    async replicatedHold(field) {
      return session.store.longTextHold({ campaignId, ...field });
    },
    settleHeldWrite(field, holdVersion) {
      return new Promise((resolve) => {
        let done = false;
        let dispose = () => {};
        const check = async () => {
          if (done) return;
          const state = await session.store.latestMutationState(campaignId, field.recordId);
          if (done || state === 'pending' || state === 'uploading') return;
          done = true;
          dispose();
          resolve(state === 'accepted' ? 'accepted' : 'failed');
          await holds.release(campaignId, field, holdVersion);
        };
        dispose = session.database.onChange(
          { onChange: () => void check() },
          { tables: ['sync_pending_mutations'], throttleMs: 50 },
        );
        void check();
      });
    },
  };
}
