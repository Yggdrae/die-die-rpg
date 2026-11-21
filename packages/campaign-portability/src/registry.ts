import type { ExportableModule, ImportableModule } from '@rpg/contracts';
import { CHUNK_PLACEMENTS, type ChunkPlacement, isModuleId } from './paths.ts';

/**
 * Contributor registry (`_prd.md` FR-003). Each content owner registers its own frozen
 * `ExportableModule`; this package never imports a contributor or its data model. The
 * composition root decides placement and, optionally, how to count a payload's logical records
 * for the safe summary (the orchestrator itself never interprets a payload).
 */

export interface ExportRegistrationOptions {
  readonly placement: ChunkPlacement;
  /** Owner-supplied logical record count of one payload, for job summaries and reports. */
  readonly countRecords?: (payload: unknown) => number;
  /**
   * The module's transaction-aware import surface (contract note 2026-10-27), when it is a
   * separate object; a module that itself implements `ImportableModule` needs none. Without
   * either, its chunks are preserved and reported as `contributor_not_transactional`.
   */
  readonly importer?: ImportableModule;
}

export interface ExportRegistration extends ExportRegistrationOptions {
  readonly module: ExportableModule;
}

export type ExportRegistrationFailure =
  | 'invalid_module_id'
  | 'duplicate_module'
  | 'invalid_placement'
  | 'duplicate_campaign_root'
  | 'importer_mismatch';

export class ExportRegistrationError extends Error {
  constructor(
    readonly code: ExportRegistrationFailure,
    readonly moduleId: string,
  ) {
    super(`export_registration: ${code} (${moduleId})`);
    this.name = 'ExportRegistrationError';
  }
}

export class ExportRegistry {
  readonly #registrations = new Map<string, ExportRegistration>();

  register(module: ExportableModule, options: ExportRegistrationOptions): this {
    const moduleId = typeof module.moduleId === 'string' ? module.moduleId : '';
    if (!isModuleId(moduleId)) throw new ExportRegistrationError('invalid_module_id', moduleId);
    if (this.#registrations.has(moduleId)) {
      throw new ExportRegistrationError('duplicate_module', moduleId);
    }
    if (!CHUNK_PLACEMENTS.includes(options.placement)) {
      throw new ExportRegistrationError('invalid_placement', moduleId);
    }
    if (
      options.placement === 'campaign' &&
      [...this.#registrations.values()].some((entry) => entry.placement === 'campaign')
    ) {
      throw new ExportRegistrationError('duplicate_campaign_root', moduleId);
    }
    if (options.importer !== undefined && options.importer.moduleId !== moduleId) {
      throw new ExportRegistrationError('importer_mismatch', moduleId);
    }
    this.#registrations.set(moduleId, { module, ...options });
    return this;
  }

  /** Sorted by module id: the export and import order. */
  list(): readonly ExportRegistration[] {
    return [...this.#registrations.values()].sort((left, right) =>
      left.module.moduleId < right.module.moduleId ? -1 : 1,
    );
  }

  get(moduleId: string): ExportRegistration | undefined {
    return this.#registrations.get(moduleId);
  }

  /** A package needs the campaign root and an attachment manifest contributor. */
  isComplete(): boolean {
    const placements = new Set([...this.#registrations.values()].map((entry) => entry.placement));
    return placements.has('campaign') && placements.has('attachments-manifest');
  }
}
