import {
  check,
  type ExportChunk,
  Id,
  type ImportableModule,
  ImportCode,
  type ImportContext,
  type ImportTransaction,
  ImportWarning,
} from '@rpg/contracts';
import { canonicalBytes, sha256Hex, utf8 } from './canonical.ts';
import type {
  InspectedChunk,
  InspectedPackage,
  InspectionCode,
  InspectionFailure,
} from './inspector.ts';
import type { ExportRegistration, ExportRegistry } from './registry.ts';
import type { ModulesLock, SystemLock } from './schemas.ts';

/**
 * Atomic import (`_db.md`, Atomic Import steps 3–7; `_techspec.md`, Import Flow). Two phases:
 *
 * 1. `planImport` is write-free. Over a package the inspector already accepted, it requires the
 *    exact pinned system and modules, decides for every chunk whether its contributor restores it
 *    or it is preserved opaquely, runs every contributor's `validate`, and builds the
 *    deterministic old-to-new id map. Any rejection happens here, before a transaction exists.
 * 2. `ImportCoordinator.commit` opens one transaction. The campaign root contributor (feature 02)
 *    creates the campaign and its sole owner, every other contributor restores in module order,
 *    preserved chunks are stored, and the job completes, all on that one transaction. Any
 *    contributor error or throw rolls everything back.
 *
 * It knows no content feature: contributors arrive through the registry, with the
 * transaction-aware `ImportableModule` contract (feature 00 note 2026-10-27, ratified 2026-10-28).
 * A contributor with only the frozen `import` is never called; its chunk is preserved.
 */

export type ImportFailureCode =
  | InspectionCode
  | 'registry_incomplete'
  | 'campaign_root_not_importable'
  | 'system_unavailable'
  | 'module_unavailable'
  | 'member_mapping_invalid'
  | 'chunk_rejected'
  | 'contributor_mismatch'
  | 'duplicate_source_id'
  | 'contributor_failed'
  | 'import_failed';

/** Safe failure: codes, validated module ids and paths, and the package's own pins only. */
export interface ImportFailure {
  readonly code: ImportFailureCode;
  readonly moduleId?: string;
  readonly path?: string;
  /** The contributor's own safe code, when it matched `ImportCode`. */
  readonly detail?: string;
  readonly unavailable?: {
    readonly system?: SystemLock;
    readonly modules?: ModulesLock['modules'];
  };
}

/** Why a chunk was preserved instead of restored. */
export type PreservedReason =
  | 'unknown_module'
  | 'contributor_not_transactional'
  | 'chunk_version_unsupported'
  | 'preserved_from_package';

export interface ImportModuleReport {
  readonly moduleId: string;
  readonly chunkVersion: string;
  readonly outcome: 'restored' | 'preserved';
  readonly restoredCount: number;
  readonly warnings: readonly ImportWarning[];
}

export interface ImportReport {
  /** Restored modules (root first, then module order), then preserved chunks. */
  readonly modules: readonly ImportModuleReport[];
}

/** Exact pins this installation lacks; never a nearby or newer version (`_bdd.md`). */
export interface RulesAvailability {
  unavailable(
    system: SystemLock,
    modules: ModulesLock,
  ): Promise<{ readonly system?: SystemLock; readonly modules: ModulesLock['modules'] }>;
}

/** One transaction shared by every contributor; a throw from `work` rolls it back. */
export interface ImportTransactionRunner {
  run<T>(work: (transaction: ImportTransaction) => Promise<T>): Promise<T>;
}

export interface PreservedChunkRow {
  readonly moduleId: string;
  readonly chunkVersion: string;
  readonly payload: unknown;
  /** SHA-256 hex of the payload's canonical JSON. */
  readonly checksum: string;
}

/** Feature 07's own writes inside the import transaction. */
export interface ImportCommitStore {
  preserve(
    transaction: ImportTransaction,
    campaignId: string,
    chunks: readonly PreservedChunkRow[],
  ): Promise<void>;
  completeJob(
    transaction: ImportTransaction,
    jobId: string,
    campaignId: string,
    report: ImportReport,
  ): Promise<void>;
}

interface RestoreStep {
  readonly module: ImportableModule;
  readonly chunk: InspectedChunk;
  readonly validationWarnings: readonly ImportWarning[];
}

interface PreservedStep extends PreservedChunkRow {
  readonly reason: PreservedReason;
}

export interface ImportPlan {
  readonly jobId: string;
  readonly importerUserId: string;
  /** New campaign id, derived from the job id: a retry of one job plans the same ids. */
  readonly campaignId: string;
  readonly manifestChecksum: string;
  readonly root: RestoreStep;
  /** Every other restorable chunk, in module order. */
  readonly restores: readonly RestoreStep[];
  /** Sorted by module id, then chunk version. */
  readonly preserved: readonly PreservedStep[];
  mapId(kind: string, sourceId: string): string | undefined;
}

export type ImportPlanResult =
  | { readonly ok: true; readonly value: ImportPlan }
  | { readonly ok: false; readonly error: ImportFailure };

export interface PlanImportInput {
  readonly jobId: string;
  readonly importerUserId: string;
  readonly inspected: InspectedPackage;
  readonly registry: ExportRegistry;
  readonly rules: RulesAvailability;
  /**
   * Approved source-member → user mapping (never derived from the package). Memberships are not
   * imported, so the importer is the only member of the new campaign and the only valid target.
   * Without an entry, `mapId('member', id)` is `undefined` and targeted Visibility narrows.
   */
  readonly memberMapping?: ReadonlyMap<string, string>;
}

/** Kinds double as safe codes. `campaign` is reserved for the root id. */
const KIND = new RegExp(ImportCode.pattern as string);
export const CAMPAIGN_KIND = 'campaign';
export const MEMBER_KIND = 'member';

const fail = (code: ImportFailureCode, where: Omit<ImportFailure, 'code'> = {}) =>
  ({ ok: false, error: { code, ...where } }) as const;

/** The module's transaction-aware surface: its registration's `importer`, or itself. */
export function importableOf(registration: ExportRegistration): ImportableModule | undefined {
  if (registration.importer !== undefined) return registration.importer;
  return isImportableModule(registration.module) ? registration.module : undefined;
}

export function isImportableModule(value: unknown): value is ImportableModule {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Partial<ImportableModule>;
  return (
    typeof candidate.moduleId === 'string' &&
    Array.isArray(candidate.importChunkVersions) &&
    typeof candidate.validate === 'function' &&
    typeof candidate.restore === 'function'
  );
}

/**
 * Deterministic id for one source record in one import job: SHA-256 of the job id, kind and
 * source id, formatted as an RFC 9562 version 8 UUID. Never equal across jobs, so a deliberate
 * second import of the same package creates distinct records.
 */
export async function deriveImportId(
  jobId: string,
  kind: string,
  sourceId: string,
): Promise<string> {
  const hex = await sha256Hex(utf8(`rpgpack-import\u0000${jobId}\u0000${kind}\u0000${sourceId}`));
  const bytes = hex.slice(0, 32).split('');
  bytes[12] = '8';
  bytes[16] = ((Number.parseInt(bytes[16] as string, 16) & 0x3) | 0x8).toString(16);
  const flat = bytes.join('');
  return `${flat.slice(0, 8)}-${flat.slice(8, 12)}-${flat.slice(12, 16)}-${flat.slice(16, 20)}-${flat.slice(20, 32)}`;
}

/** A contributor's error string, kept only when it is a safe code. */
function safeDetail(value: unknown): string | undefined {
  return typeof value === 'string' && check(ImportCode, value) ? value : undefined;
}

function toChunk(chunk: InspectedChunk): ExportChunk {
  return { moduleId: chunk.moduleId, chunkVersion: chunk.chunkVersion, payload: chunk.payload };
}

async function preservedRow(
  moduleId: string,
  chunkVersion: string,
  payload: unknown,
  reason: PreservedReason,
): Promise<PreservedStep> {
  return {
    moduleId,
    chunkVersion,
    payload,
    checksum: await sha256Hex(canonicalBytes(payload)),
    reason,
  };
}

export async function planImport(input: PlanImportInput): Promise<ImportPlanResult> {
  const { inspected, registry } = input;
  if (!check(Id, input.jobId) || !check(Id, input.importerUserId)) {
    return fail('import_failed');
  }
  if (!registry.isComplete()) return fail('registry_incomplete');

  // Exact pinned rules context, before anything else is planned (`_bdd.md`, unavailable system).
  const unavailable = await input.rules.unavailable(inspected.systemLock, inspected.modulesLock);
  if (unavailable.system !== undefined) {
    return fail('system_unavailable', { unavailable: { system: unavailable.system } });
  }
  if (unavailable.modules.length > 0) {
    return fail('module_unavailable', { unavailable: { modules: [...unavailable.modules] } });
  }

  const memberMapping = input.memberMapping ?? new Map<string, string>();
  for (const [source, target] of memberMapping) {
    if (!check(Id, source) || target !== input.importerUserId) {
      return fail('member_mapping_invalid');
    }
  }

  let root: RestoreStep | undefined;
  const restores: RestoreStep[] = [];
  const preserved: PreservedStep[] = [];
  const defined = new Map<string, string>();
  const sourceCampaignId = inspected.manifest.source.campaignId;
  defined.set(`${CAMPAIGN_KIND}\u0000${sourceCampaignId}`, '');

  for (const chunk of inspected.chunks) {
    const registration = registry.get(chunk.moduleId);
    if (registration === undefined) {
      if (chunk.placement === 'campaign') return fail('campaign_root_not_importable');
      preserved.push(
        await preservedRow(chunk.moduleId, chunk.chunkVersion, chunk.payload, 'unknown_module'),
      );
      continue;
    }
    if (registration.placement !== chunk.placement) {
      return fail('chunk_rejected', {
        moduleId: chunk.moduleId,
        path: chunk.path,
        detail: 'placement_mismatch',
      });
    }
    const module = importableOf(registration);
    const isRoot = chunk.placement === 'campaign';
    if (module === undefined || module.moduleId !== chunk.moduleId) {
      if (isRoot) return fail('campaign_root_not_importable', { moduleId: chunk.moduleId });
      preserved.push(
        await preservedRow(
          chunk.moduleId,
          chunk.chunkVersion,
          chunk.payload,
          'contributor_not_transactional',
        ),
      );
      continue;
    }
    if (!module.importChunkVersions.includes(chunk.chunkVersion)) {
      if (isRoot) {
        return fail('chunk_rejected', {
          moduleId: chunk.moduleId,
          detail: 'chunk_version_unsupported',
        });
      }
      preserved.push(
        await preservedRow(
          chunk.moduleId,
          chunk.chunkVersion,
          chunk.payload,
          'chunk_version_unsupported',
        ),
      );
      continue;
    }

    let validated: Awaited<ReturnType<ImportableModule['validate']>>;
    try {
      validated = await module.validate(toChunk(chunk));
    } catch {
      return fail('chunk_rejected', { moduleId: chunk.moduleId });
    }
    if (validated === null || typeof validated !== 'object') {
      return fail('contributor_mismatch', { moduleId: chunk.moduleId });
    }
    if (!validated.ok) {
      const detail = safeDetail(validated.error);
      return fail('chunk_rejected', {
        moduleId: chunk.moduleId,
        ...(detail === undefined ? {} : { detail }),
      });
    }
    const contribution = validated.value;
    if (
      contribution === null ||
      typeof contribution !== 'object' ||
      !Array.isArray(contribution.defines) ||
      !Array.isArray(contribution.warnings) ||
      !contribution.warnings.every((warning) => check(ImportWarning, warning))
    ) {
      return fail('contributor_mismatch', { moduleId: chunk.moduleId });
    }
    for (const entry of contribution.defines) {
      if (
        entry === null ||
        typeof entry !== 'object' ||
        typeof entry.kind !== 'string' ||
        !KIND.test(entry.kind) ||
        entry.kind === CAMPAIGN_KIND ||
        entry.kind === MEMBER_KIND ||
        !check(Id, entry.sourceId)
      ) {
        return fail('contributor_mismatch', { moduleId: chunk.moduleId });
      }
      const key = `${entry.kind}\u0000${entry.sourceId}`;
      if (defined.has(key)) return fail('duplicate_source_id', { moduleId: chunk.moduleId });
      defined.set(key, '');
    }
    const step: RestoreStep = {
      module,
      chunk,
      validationWarnings: contribution.warnings.map((warning) => ({ ...warning })),
    };
    if (isRoot) root = step;
    else restores.push(step);
  }
  if (root === undefined) return fail('campaign_root_not_importable');

  // Chunks the package itself preserved stay opaque, whatever this installation recognizes.
  for (const chunk of inspected.preserved) {
    preserved.push(
      await preservedRow(
        chunk.moduleId,
        chunk.chunkVersion,
        chunk.payload,
        'preserved_from_package',
      ),
    );
  }
  preserved.sort((left, right) => {
    const a = `${left.moduleId}\u0000${left.chunkVersion}`;
    const b = `${right.moduleId}\u0000${right.chunkVersion}`;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  for (let index = 1; index < preserved.length; index += 1) {
    const previous = preserved[index - 1] as PreservedStep;
    const current = preserved[index] as PreservedStep;
    if (previous.moduleId === current.moduleId && previous.chunkVersion === current.chunkVersion) {
      return fail('duplicate_module', { moduleId: current.moduleId });
    }
  }

  const ids = new Map<string, string>();
  for (const key of defined.keys()) {
    const [kind, sourceId] = key.split('\u0000') as [string, string];
    ids.set(key, await deriveImportId(input.jobId, kind, sourceId));
  }
  const campaignId = ids.get(`${CAMPAIGN_KIND}\u0000${sourceCampaignId}`) as string;
  const mapping = new Map(memberMapping);
  return {
    ok: true,
    value: {
      jobId: input.jobId,
      importerUserId: input.importerUserId,
      campaignId,
      manifestChecksum: inspected.manifestChecksum,
      root,
      restores: restores.sort((a, b) => (a.chunk.moduleId < b.chunk.moduleId ? -1 : 1)),
      preserved,
      mapId: (kind, sourceId) =>
        ids.get(`${kind}\u0000${sourceId}`) ??
        (kind === MEMBER_KIND ? mapping.get(sourceId) : undefined),
    },
  };
}

class RestoreFailure extends Error {
  constructor(
    readonly code: 'contributor_failed' | 'contributor_mismatch',
    readonly moduleId: string,
    readonly detail?: string,
  ) {
    super(`import_restore: ${code} (${moduleId})`);
    this.name = 'RestoreFailure';
  }
}

export type ImportCommitResult =
  | {
      readonly ok: true;
      readonly value: { readonly campaignId: string; readonly report: ImportReport };
    }
  | { readonly ok: false; readonly error: ImportFailure };

export class ImportCoordinator {
  constructor(
    private readonly deps: {
      readonly transactions: ImportTransactionRunner;
      readonly store: ImportCommitStore;
    },
  ) {}

  async commit(plan: ImportPlan): Promise<ImportCommitResult> {
    try {
      const report = await this.deps.transactions.run(async (transaction) => {
        const context: ImportContext = Object.freeze({
          campaignId: plan.campaignId,
          importerUserId: plan.importerUserId,
          mapId: (kind: string, sourceId: string) => plan.mapId(kind, sourceId),
          transaction,
        });
        const modules: ImportModuleReport[] = [];
        for (const step of [plan.root, ...plan.restores]) {
          modules.push(await restoreStep(step, context));
        }
        await this.deps.store.preserve(
          transaction,
          plan.campaignId,
          plan.preserved.map(({ moduleId, chunkVersion, payload, checksum }) => ({
            moduleId,
            chunkVersion,
            payload,
            checksum,
          })),
        );
        for (const chunk of plan.preserved) {
          modules.push({
            moduleId: chunk.moduleId,
            chunkVersion: chunk.chunkVersion,
            outcome: 'preserved',
            restoredCount: 0,
            warnings: [{ code: chunk.reason }],
          });
        }
        const report: ImportReport = { modules };
        await this.deps.store.completeJob(transaction, plan.jobId, plan.campaignId, report);
        return report;
      });
      return { ok: true, value: { campaignId: plan.campaignId, report } };
    } catch (error) {
      if (error instanceof RestoreFailure) {
        return {
          ok: false,
          error: {
            code: error.code,
            moduleId: error.moduleId,
            ...(error.detail === undefined ? {} : { detail: error.detail }),
          },
        };
      }
      return { ok: false, error: { code: 'import_failed' } };
    }
  }
}

async function restoreStep(step: RestoreStep, context: ImportContext): Promise<ImportModuleReport> {
  const moduleId = step.chunk.moduleId;
  let restored: Awaited<ReturnType<ImportableModule['restore']>>;
  try {
    restored = await step.module.restore(toChunk(step.chunk), context);
  } catch {
    throw new RestoreFailure('contributor_failed', moduleId);
  }
  if (restored === null || typeof restored !== 'object') {
    throw new RestoreFailure('contributor_mismatch', moduleId);
  }
  if (!restored.ok) {
    throw new RestoreFailure('contributor_failed', moduleId, safeDetail(restored.error));
  }
  const result = restored.value;
  if (
    result === null ||
    typeof result !== 'object' ||
    !Number.isInteger(result.restoredCount) ||
    result.restoredCount < 0 ||
    !Array.isArray(result.warnings) ||
    !result.warnings.every((warning) => check(ImportWarning, warning))
  ) {
    throw new RestoreFailure('contributor_mismatch', moduleId);
  }
  return {
    moduleId,
    chunkVersion: step.chunk.chunkVersion,
    outcome: 'restored',
    restoredCount: result.restoredCount,
    warnings: [...step.validationWarnings, ...result.warnings.map((warning) => ({ ...warning }))],
  };
}

/** For `InspectionFailure` → `ImportFailure`, the same safe fields. */
export function inspectionFailure(failure: InspectionFailure): ImportFailure {
  return {
    code: failure.code,
    ...(failure.path === undefined ? {} : { path: failure.path }),
    ...(failure.moduleId === undefined ? {} : { moduleId: failure.moduleId }),
  };
}
