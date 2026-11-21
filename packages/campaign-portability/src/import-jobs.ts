import { check, Id, type ImportTransaction, type ImportWarning } from '@rpg/contracts';
import {
  type ImportCommitStore,
  type ImportCoordinator,
  type ImportFailure,
  type ImportFailureCode,
  type ImportReport,
  inspectionFailure,
  type PlanImportInput,
  type PreservedChunkRow,
  planImport,
} from './importer.ts';
import { type InspectionOptions, inspectPackage } from './inspector.ts';
import type { ExportRegistry } from './registry.ts';

/**
 * Import jobs (`_db.md`, `import_jobs`). A job id makes one import idempotent: a retry returns
 * the job as it stands and never restores twice. A deliberate second import of the same file
 * uses a new job id and creates a second campaign. Package bytes are held only for the request;
 * the job keeps the manifest checksum, the safe report or failure, and the new campaign id.
 */

export type ImportJobState = 'running' | 'completed' | 'failed';

/** Failure details stored with a failed job: everything in `ImportFailure` except its code. */
export type ImportFailureDetails = Omit<ImportFailure, 'code'>;

export interface ImportJob {
  readonly id: string;
  readonly requestedBy: string;
  readonly sourceManifestChecksum?: string;
  readonly state: ImportJobState;
  readonly campaignId?: string;
  readonly report: ImportReport;
  readonly failure?: ImportFailureDetails;
  readonly errorCode?: ImportFailureCode;
  readonly createdAt: Date;
  readonly completedAt?: Date;
}

export const IMPORT_JOB_RETENTION_DAYS = 90;

export interface ImportJobRepository {
  /** Inserts a `running` job; returns the existing row unchanged when the id already exists. */
  create(input: {
    readonly id: string;
    readonly requestedBy: string;
    readonly sourceManifestChecksum?: string;
  }): Promise<{ readonly job: ImportJob; readonly created: boolean }>;
  /** Only a `running` job fails; a completed job never changes afterwards. */
  fail(id: string, code: ImportFailureCode, details: ImportFailureDetails): Promise<void>;
  get(id: string): Promise<ImportJob | undefined>;
  /** Hard-deletes jobs older than the retention window (database time, exclusive). */
  deleteExpired(): Promise<number>;
}

/** In-memory store for unit tests: a "transaction" buffers writes and applies them on commit. */
export class MemoryImportStore implements ImportJobRepository, ImportCommitStore {
  readonly jobs = new Map<string, ImportJob>();
  readonly preserved = new Map<string, PreservedChunkRow[]>();
  readonly #pending = new WeakMap<ImportTransaction, (() => void)[]>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  async run<T>(work: (transaction: ImportTransaction) => Promise<T>): Promise<T> {
    const transaction: ImportTransaction = Object.freeze({ brand: 'ImportTransaction' as const });
    const writes: (() => void)[] = [];
    this.#pending.set(transaction, writes);
    const result = await work(transaction);
    for (const write of writes) write();
    return result;
  }

  /** Records a write to apply only if the transaction commits. */
  later(transaction: ImportTransaction, write: () => void): void {
    const writes = this.#pending.get(transaction);
    if (writes === undefined) throw new Error('import transaction is not open');
    writes.push(write);
  }

  async create(input: { id: string; requestedBy: string; sourceManifestChecksum?: string }) {
    const existing = this.jobs.get(input.id);
    if (existing !== undefined) return { job: existing, created: false };
    const job: ImportJob = {
      id: input.id,
      requestedBy: input.requestedBy,
      ...(input.sourceManifestChecksum === undefined
        ? {}
        : { sourceManifestChecksum: input.sourceManifestChecksum }),
      state: 'running',
      report: { modules: [] },
      createdAt: this.now(),
    };
    this.jobs.set(job.id, job);
    return { job, created: true };
  }

  async fail(id: string, code: ImportFailureCode, details: ImportFailureDetails) {
    const job = this.jobs.get(id);
    if (job === undefined || job.state !== 'running') return;
    this.jobs.set(id, {
      ...job,
      state: 'failed',
      errorCode: code,
      failure: details,
      completedAt: this.now(),
    });
  }

  async get(id: string) {
    return this.jobs.get(id);
  }

  async deleteExpired() {
    const cutoff = this.now().getTime() - IMPORT_JOB_RETENTION_DAYS * 86_400_000;
    let deleted = 0;
    for (const [id, job] of this.jobs) {
      if (job.createdAt.getTime() < cutoff) {
        this.jobs.delete(id);
        deleted += 1;
      }
    }
    return deleted;
  }

  async preserve(
    transaction: ImportTransaction,
    campaignId: string,
    chunks: readonly PreservedChunkRow[],
  ) {
    this.later(transaction, () => {
      if (chunks.length > 0) this.preserved.set(campaignId, [...chunks]);
    });
  }

  async completeJob(
    transaction: ImportTransaction,
    jobId: string,
    campaignId: string,
    report: ImportReport,
  ) {
    this.later(transaction, () => {
      const job = this.jobs.get(jobId);
      if (job === undefined || job.state !== 'running') throw new Error('import job not running');
      this.jobs.set(jobId, {
        ...job,
        state: 'completed',
        campaignId,
        report,
        completedAt: this.now(),
      });
    });
  }
}

/** Serializable copy of one module report. */
export interface ImportModuleView {
  readonly moduleId: string;
  readonly chunkVersion: string;
  readonly outcome: 'restored' | 'preserved';
  readonly restoredCount: number;
  readonly warnings: ImportWarning[];
}

export interface ImportJobView {
  readonly jobId: string;
  readonly state: ImportJobState;
  /** Present once the import committed. */
  readonly campaignId?: string;
  readonly report: { readonly modules: ImportModuleView[] };
  readonly errorCode?: string;
  readonly failure?: ImportFailureDetails;
  readonly createdAt: string;
  readonly completedAt?: string;
}

export type StartImportError = 'job_conflict';

/**
 * Runs one import as a job for an authenticated user, who becomes the sole owner of the new
 * campaign. Inspection and planning are write-free; only a fully planned import opens the
 * transaction (`_bdd.md`, Validation Before Import; Atomic Import).
 */
export class ImportService {
  constructor(
    private readonly deps: {
      readonly jobs: ImportJobRepository;
      readonly coordinator: Pick<ImportCoordinator, 'commit'>;
      readonly registry: ExportRegistry;
      readonly rules: PlanImportInput['rules'];
      readonly inspection?: InspectionOptions;
      /** After commit only (e.g. the feature 02 audit event). A failure never fails the import. */
      readonly committed?: (input: { campaignId: string; userId: string }) => Promise<void>;
      /** Codes and module ids only; never payload, path content or package bytes. */
      readonly log?: { importFailed(code: string, moduleId?: string): void };
    },
  ) {}

  async start(input: {
    readonly jobId: string;
    readonly userId: string;
    readonly bytes: Uint8Array;
  }): Promise<{ ok: true; value: ImportJobView } | { ok: false; error: StartImportError }> {
    if (!check(Id, input.jobId) || !check(Id, input.userId)) {
      return { ok: false, error: 'job_conflict' };
    }
    const existing = await this.deps.jobs.get(input.jobId);
    if (existing !== undefined) return this.#settled(existing, input.userId);

    const inspected = await inspectPackage(input.bytes, this.deps.inspection);
    if (!inspected.ok) {
      return this.#failBeforeWrite(input, undefined, inspectionFailure(inspected.error));
    }
    const planned = await planImport({
      jobId: input.jobId,
      importerUserId: input.userId,
      inspected: inspected.value,
      registry: this.deps.registry,
      rules: this.deps.rules,
    });
    if (!planned.ok) {
      return this.#failBeforeWrite(input, inspected.value.manifestChecksum, planned.error);
    }

    const { job, created } = await this.deps.jobs.create({
      id: input.jobId,
      requestedBy: input.userId,
      sourceManifestChecksum: inspected.value.manifestChecksum,
    });
    if (!created) return this.#settled(job, input.userId);

    const committed = await this.deps.coordinator.commit(planned.value);
    if (!committed.ok) {
      const { code, ...details } = committed.error;
      this.deps.log?.importFailed(code, details.moduleId);
      await this.deps.jobs.fail(job.id, code, details);
    } else {
      try {
        await this.deps.committed?.({
          campaignId: committed.value.campaignId,
          userId: input.userId,
        });
      } catch {
        // Post-commit integrations degrade on their own; the campaign is already imported.
      }
    }
    return this.#settled((await this.deps.jobs.get(job.id)) ?? job, input.userId);
  }

  /** The job, only for its requesting user. */
  async status(jobId: string, userId: string): Promise<ImportJobView | undefined> {
    const job = await this.deps.jobs.get(jobId);
    return job === undefined || job.requestedBy !== userId ? undefined : view(job);
  }

  async #failBeforeWrite(
    input: { readonly jobId: string; readonly userId: string },
    checksum: string | undefined,
    failure: ImportFailure,
  ) {
    const { code, ...details } = failure;
    this.deps.log?.importFailed(code, details.moduleId);
    const { job, created } = await this.deps.jobs.create({
      id: input.jobId,
      requestedBy: input.userId,
      ...(checksum === undefined ? {} : { sourceManifestChecksum: checksum }),
    });
    if (created) await this.deps.jobs.fail(job.id, code, details);
    return this.#settled((await this.deps.jobs.get(job.id)) ?? job, input.userId);
  }

  #settled(
    job: ImportJob,
    userId: string,
  ): { ok: true; value: ImportJobView } | { ok: false; error: StartImportError } {
    return job.requestedBy === userId
      ? { ok: true, value: view(job) }
      : { ok: false, error: 'job_conflict' };
  }
}

function view(job: ImportJob): ImportJobView {
  return {
    jobId: job.id,
    state: job.state,
    ...(job.campaignId === undefined ? {} : { campaignId: job.campaignId }),
    report: {
      modules: job.report.modules.map((module) => ({
        moduleId: module.moduleId,
        chunkVersion: module.chunkVersion,
        outcome: module.outcome,
        restoredCount: module.restoredCount,
        warnings: module.warnings.map((warning) => ({ ...warning })),
      })),
    },
    ...(job.errorCode === undefined ? {} : { errorCode: job.errorCode }),
    ...(job.failure === undefined ? {} : { failure: job.failure }),
    createdAt: job.createdAt.toISOString(),
    ...(job.completedAt === undefined ? {} : { completedAt: job.completedAt.toISOString() }),
  };
}
