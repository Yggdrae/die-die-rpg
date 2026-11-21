import type { TombstonePurgeBlocker, TombstonePurgeEvidence } from '@rpg/contracts';
import type { AttachmentRecord, AttachmentRetentionRepository } from './application.ts';
import { isObjectKey } from './content.ts';
import type { ObjectStorage } from './storage.ts';

/**
 * Deletion retention and object/metadata reconciliation (`_db.md`, Deletion and Reconciliation;
 * `_bdd.md`, Deletion and Retention). Object storage is not transactional with PostgreSQL, so
 * every step is idempotent and runs outside user transactions; a failed step leaves its row
 * eligible for the next pass (the row itself is the retry state).
 *
 * `run()`:
 * 1. Campaign deletion: every live attachment of a deleted campaign is tombstoned under the same
 *    30-day rule (no feature 02 hook exists; detected by reconciliation, at most one pass late).
 * 2. Purge: a tombstone past `purge_after` (database time, exclusive) is purged only when no
 *    retained export/import job references it and, when its metadata replicates, feature 03's
 *    watermark says the tombstone is safe. Then the object is deleted (a missing object is
 *    success) and only after that the metadata row is hard-deleted.
 *
 * `diagnose()` reports orphan objects and ready metadata whose object is missing. It never
 * deletes, restores or rewrites either side.
 */

/** Feature 02 seam: whether a campaign is gone (soft-deleted or absent). */
export interface CampaignLifecycle {
  isDeleted(campaignId: string): Promise<boolean>;
}

/**
 * Feature 07 seam: attachments a retained export/import job still references. Feature 07's export
 * job store holds every attachment of a campaign whose export is still requested or running.
 */
export interface RetainedAttachmentReferences {
  referenced(
    attachments: readonly { readonly id: string; readonly campaignId: string }[],
  ): Promise<ReadonlySet<string>>;
}

export const NO_RETAINED_ATTACHMENT_REFERENCES: RetainedAttachmentReferences = {
  referenced: async () => new Set(),
};

/** Replica scope of attachment metadata if it is ever replicated (feature 03 watermark). */
export const ATTACHMENT_TOMBSTONE_SCOPE = 'attachments';

export interface AttachmentReconcilerDependencies {
  readonly repository: AttachmentRetentionRepository;
  readonly storage: ObjectStorage;
  readonly campaigns: CampaignLifecycle;
  readonly references: RetainedAttachmentReferences;
  /**
   * Feature 03 tombstone evidence. Required as soon as a replica can hold an attachment tombstone.
   * Today none can: the export metadata stream (feature 07 task 05) carries only live `ready` rows,
   * so a deletion removes the row from the replica and the gate is vacuous.
   */
  readonly syncTombstones?: Pick<TombstonePurgeEvidence, 'decide'>;
  /** Rows (and campaigns) per step per pass. Default 100. */
  readonly batchSize?: number;
  readonly now?: () => Date;
}

export interface ReconciliationReport {
  /** Deleted campaigns whose live attachments were tombstoned this pass. */
  readonly deletedCampaigns: number;
  readonly tombstoned: number;
  readonly purged: number;
  readonly retainedByReference: number;
  readonly retainedByWatermark: number;
  readonly storageFailures: number;
}

export interface OrphanObject {
  readonly campaignId: string;
  readonly attachmentId: string;
}

export interface ReconciliationDiagnosis {
  /** Objects no metadata row names (identified by the IDs in their opaque key, never the key). */
  readonly orphanObjects: readonly OrphanObject[];
  /** Objects under the attachment prefix that are not attachment keys at all. */
  readonly foreignObjects: number;
  /** Ready live attachments whose object is missing; they read as unavailable. */
  readonly missingObjects: readonly string[];
  readonly scannedObjects: number;
  readonly scannedRows: number;
  /** `false` when a page limit stopped the scan; the next diagnosis covers the rest. */
  readonly complete: boolean;
}

const KEY_PREFIX = 'campaigns/';

export class AttachmentReconciler {
  readonly #deps: AttachmentReconcilerDependencies;
  readonly #now: () => Date;

  constructor(deps: AttachmentReconcilerDependencies) {
    this.#deps = deps;
    this.#now = deps.now ?? (() => new Date());
  }

  async run(): Promise<ReconciliationReport> {
    const limit = this.#deps.batchSize ?? 100;
    let deletedCampaigns = 0;
    let tombstoned = 0;
    for (const campaignId of await this.#deps.repository.campaignsWithLiveAttachments(limit)) {
      if (!(await this.#deps.campaigns.isDeleted(campaignId))) continue;
      deletedCampaigns += 1;
      tombstoned += await this.#deps.repository.tombstoneCampaign(campaignId);
    }

    const due = await this.#deps.repository.purgeDue(limit);
    const referenced = await this.#deps.references.referenced(
      due.map((row) => ({ id: row.id, campaignId: row.campaignId })),
    );
    let purged = 0;
    let retainedByReference = 0;
    let retainedByWatermark = 0;
    let storageFailures = 0;
    for (const row of due) {
      if (referenced.has(row.id)) {
        retainedByReference += 1;
        continue;
      }
      if ((await this.#watermarkBlockers(row)).length > 0) {
        retainedByWatermark += 1;
        continue;
      }
      try {
        await this.#deps.storage.delete(row.objectKey);
      } catch {
        storageFailures += 1;
        continue;
      }
      // Object deletion confirmed: only now may the metadata (and its tombstone) go.
      if (await this.#deps.repository.hardDeleteTombstone(row.id)) purged += 1;
    }
    return {
      deletedCampaigns,
      tombstoned,
      purged,
      retainedByReference,
      retainedByWatermark,
      storageFailures,
    };
  }

  /** Report-only comparison of both sides, bounded by `maxPages` pages of `pageSize` keys/rows. */
  async diagnose(
    options: { readonly pageSize?: number; readonly maxPages?: number } = {},
  ): Promise<ReconciliationDiagnosis> {
    const pageSize = options.pageSize ?? 500;
    const maxPages = options.maxPages ?? 20;
    const orphanObjects: OrphanObject[] = [];
    const missingObjects: string[] = [];
    let foreignObjects = 0;
    let scannedObjects = 0;
    let scannedRows = 0;
    let complete = true;

    let after: string | undefined;
    for (let page = 0; ; page += 1) {
      if (page === maxPages) {
        complete = false;
        break;
      }
      const listed = await this.#deps.storage.list({
        prefix: KEY_PREFIX,
        limit: pageSize,
        ...(after === undefined ? {} : { after }),
      });
      scannedObjects += listed.keys.length;
      const known = await this.#deps.repository.knownObjectKeys(listed.keys);
      for (const key of listed.keys) {
        if (known.has(key)) continue;
        if (!isObjectKey(key)) {
          foreignObjects += 1;
          continue;
        }
        const [, campaignId = '', attachmentId = ''] = key.split('/');
        orphanObjects.push({ campaignId, attachmentId });
      }
      if (listed.after === undefined) break;
      after = listed.after;
    }

    let afterId: string | undefined;
    for (let page = 0; ; page += 1) {
      if (page === maxPages) {
        complete = false;
        break;
      }
      const rows = await this.#deps.repository.readyLive(pageSize, afterId);
      scannedRows += rows.length;
      for (const row of rows) {
        if ((await this.#deps.storage.inspect(row.objectKey)) === undefined) {
          missingObjects.push(row.id);
        }
      }
      if (rows.length < pageSize) break;
      afterId = rows.at(-1)?.id;
    }
    return { orphanObjects, foreignObjects, missingObjects, scannedObjects, scannedRows, complete };
  }

  /** Runs `run` every `intervalMs` (default hourly); never overlaps itself. Returns a stopper. */
  startLoop(
    intervalMs = 3_600_000,
    report: (outcome: ReconciliationReport | 'failed') => void = () => undefined,
  ): () => void {
    let running = false;
    const timer = setInterval(() => {
      if (running) return;
      running = true;
      this.run().then(
        (outcome) => {
          running = false;
          report(outcome);
        },
        () => {
          running = false;
          report('failed');
        },
      );
    }, intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  async #watermarkBlockers(row: AttachmentRecord): Promise<readonly TombstonePurgeBlocker[]> {
    const evidence = this.#deps.syncTombstones;
    if (evidence === undefined || row.deletedAt === undefined) return [];
    try {
      const decision = await evidence.decide(
        {
          campaignId: row.campaignId,
          scope: ATTACHMENT_TOMBSTONE_SCOPE,
          recordId: row.id,
          sequence: row.version,
          deletedAt: row.deletedAt.toISOString(),
        },
        this.#now(),
      );
      return decision.safe ? [] : decision.blockers;
    } catch {
      // No evidence is never permission: keep the tombstone and its bytes.
      return ['unacknowledged_replica'];
    }
  }
}
