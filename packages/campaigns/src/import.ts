import {
  check,
  type ExportChunk,
  err,
  type ImportableModule,
  type ImportContext,
  type ImportPlanContribution,
  type ImportResult,
  type ImportTransaction,
  type ImportWarning,
  ok,
  type Result,
} from '@rpg/contracts';
import type { CampaignMembershipWriter } from '@rpg/identity';
import type { CampaignRecord } from './application.ts';
import type { SystemCatalog } from './contracts.ts';
import { type CampaignSettingRegistry, validateCampaignInput } from './domain.ts';
import { CAMPAIGN_CHUNK_VERSION, CAMPAIGN_EXPORT_MODULE_ID, CampaignChunk } from './export.ts';

/**
 * Feature 02 contribution to feature 07's atomic import (contract note 2026-10-27, ratified
 * 2026-10-28): the campaign root of a package becomes a new campaign whose sole owner is the
 * importing user, created on the import transaction together with every other contributor.
 *
 * Validation is the same as campaign creation, against the exact pinned system and module
 * versions; nothing is substituted. Original memberships are never restored. A setting
 * namespace this installation does not register is reported (`setting_not_restored`), never
 * stored unvalidated; a registered one keeps its declared member visibility, so a hidden setting
 * never becomes member-visible.
 */

/** Feature 02 persistence on a caller-supplied transaction handle. */
export interface CampaignImportWriter {
  createWithin(
    handle: unknown,
    record: CampaignRecord,
    ownerWriter: CampaignMembershipWriter,
    memberVisible: (namespace: string) => boolean,
  ): Promise<void>;
}

export const SETTING_NOT_RESTORED = 'setting_not_restored';

interface PlannedCampaign {
  readonly fields: Pick<
    CampaignRecord,
    'name' | 'description' | 'system' | 'gameMode' | 'modulePins' | 'settings'
  >;
  readonly memberVisible: ReadonlyMap<string, boolean>;
  readonly warnings: readonly ImportWarning[];
}

export class CampaignImporter implements ImportableModule {
  readonly moduleId = CAMPAIGN_EXPORT_MODULE_ID;
  readonly importChunkVersions = [CAMPAIGN_CHUNK_VERSION] as const;

  constructor(
    private readonly deps: {
      readonly catalog: Pick<SystemCatalog, 'resolveExact'>;
      readonly settings: Pick<CampaignSettingRegistry, 'get' | 'validate'>;
      readonly writer: CampaignImportWriter;
      readonly ownerWriter: CampaignMembershipWriter;
      /** Composition-root resolver of the opaque import transaction. */
      readonly unwrap: (transaction: ImportTransaction) => unknown;
      readonly now?: () => Date;
    },
  ) {}

  async validate(chunk: ExportChunk): Promise<Result<ImportPlanContribution, string>> {
    const planned = await this.#plan(chunk);
    return planned.ok ? ok({ defines: [], warnings: planned.value.warnings }) : planned;
  }

  async restore(chunk: ExportChunk, context: ImportContext): Promise<Result<ImportResult, string>> {
    const planned = await this.#plan(chunk);
    if (!planned.ok) return planned;
    const at = (this.deps.now?.() ?? new Date()).toISOString();
    const record: CampaignRecord = {
      id: context.campaignId,
      ...planned.value.fields,
      version: 1,
      createdAt: at,
      updatedAt: at,
      createdBy: context.importerUserId,
    };
    const visibility = planned.value.memberVisible;
    try {
      await this.deps.writer.createWithin(
        this.deps.unwrap(context.transaction),
        record,
        this.deps.ownerWriter,
        (namespace) => visibility.get(namespace) ?? false,
      );
    } catch {
      return err('campaign_restore_failed');
    }
    // Warnings were reported by `validate`; the host keeps them with this module's report.
    return ok({ restoredCount: 1, warnings: [] });
  }

  async #plan(chunk: ExportChunk): Promise<Result<PlannedCampaign, string>> {
    if (
      chunk.moduleId !== this.moduleId ||
      chunk.chunkVersion !== CAMPAIGN_CHUNK_VERSION ||
      !check(CampaignChunk, chunk.payload)
    ) {
      return err('campaign_chunk_invalid');
    }
    const payload = chunk.payload;
    const system = await this.deps.catalog.resolveExact(payload.system);
    if (system === undefined) return err('system_unavailable');
    const options = payload.settings.system ?? {};
    if (typeof options !== 'object' || options === null || Array.isArray(options)) {
      return err('campaign_chunk_invalid');
    }
    const moduleIds = payload.modulePins.map((pin) => pin.moduleId);
    if (new Set(moduleIds).size !== moduleIds.length) return err('campaign_chunk_invalid');
    const invalid = validateCampaignInput(
      {
        id: '00000000-0000-4000-8000-000000000000',
        system: payload.system,
        gameMode: payload.gameMode,
        options: options as Record<string, unknown>,
        moduleIds,
        name: payload.name,
        description: payload.description,
      },
      system,
    );
    if (invalid !== undefined) return err(invalid);
    // Exact module versions: a pin the installation declares at another version is unavailable.
    for (const pin of payload.modulePins) {
      const declared = system.compatibleModules.find((module) => module.id === pin.moduleId);
      if (declared?.version !== pin.version) return err('module_unavailable');
    }

    const settings: Record<string, unknown> = { system: structuredClone(options) };
    const memberVisible = new Map<string, boolean>([['system', true]]);
    let skipped = 0;
    for (const [namespace, value] of Object.entries(payload.settings)) {
      if (namespace === 'system') continue;
      const registration = this.deps.settings.get(namespace);
      if (registration === undefined) {
        skipped += 1;
        continue;
      }
      if (this.deps.settings.validate(namespace, value) !== undefined) {
        return err('invalid_setting');
      }
      settings[namespace] = structuredClone(value);
      memberVisible.set(namespace, registration.memberVisible);
    }
    return ok({
      fields: {
        name: payload.name.trim(),
        description: payload.description,
        system: { systemId: payload.system.systemId, version: payload.system.version },
        gameMode: payload.gameMode,
        modulePins: payload.modulePins.map((pin) => ({
          moduleId: pin.moduleId,
          version: pin.version,
        })),
        settings,
      },
      memberVisible,
      warnings: skipped === 0 ? [] : [{ code: SETTING_NOT_RESTORED, count: skipped }],
    });
  }
}
