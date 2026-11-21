import type { AttachmentRepository } from './application.ts';
import type { ObjectStorage } from './storage.ts';

/**
 * Abandoned-upload collection (`_db.md`, Upload Lifecycle; `_bdd.md`, An abandoned upload is
 * collected). Never touches a ready row: deleted ready bytes follow the 30-day retention of task
 * 06. Each step is idempotent and a provider fault leaves the row for the next pass.
 *
 * 1. Pending rows older than 24 hours (database time): delete the object, then mark failed.
 * 2. Pending or failed rows older than 7 days: delete the object again (a missing object is
 *    success), then hard-delete the metadata. Such rows were never synchronized.
 */
export interface CleanupReport {
  readonly expired: number;
  readonly purged: number;
  readonly storageFailures: number;
}

export interface AttachmentCleanupDependencies {
  readonly repository: AttachmentRepository;
  readonly storage: ObjectStorage;
  /** Rows per step per pass. Default 100. */
  readonly batchSize?: number;
}

export class AttachmentCleanup {
  constructor(private readonly deps: AttachmentCleanupDependencies) {}

  async run(): Promise<CleanupReport> {
    const limit = this.deps.batchSize ?? 100;
    let expired = 0;
    let purged = 0;
    let storageFailures = 0;
    for (const row of await this.deps.repository.expiredPending(limit)) {
      if (!(await this.#deleteObject(row.objectKey))) {
        storageFailures += 1;
        continue;
      }
      if (await this.deps.repository.markFailed(row.campaignId, row.id)) expired += 1;
    }
    for (const row of await this.deps.repository.abandoned(limit)) {
      if (!(await this.#deleteObject(row.objectKey))) {
        storageFailures += 1;
        continue;
      }
      if (await this.deps.repository.hardDeleteUnready(row.id)) purged += 1;
    }
    return { expired, purged, storageFailures };
  }

  /** Runs `run` every `intervalMs` (default hourly); never overlaps itself. Returns a stopper. */
  startLoop(
    intervalMs = 3_600_000,
    report: (outcome: CleanupReport | 'failed') => void = () => undefined,
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

  async #deleteObject(key: string): Promise<boolean> {
    try {
      await this.deps.storage.delete(key);
      return true;
    } catch {
      return false;
    }
  }
}
