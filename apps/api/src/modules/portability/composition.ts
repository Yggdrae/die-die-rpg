import {
  type AttachmentManifest,
  AttachmentManifestExporter,
  type AttachmentRepository,
  type RetainedAttachmentReferences,
} from '@rpg/attachments';
import {
  type ExportJobRepository,
  ExportOrchestrator,
  ExportRegistry,
  type ImportCommitStore,
  ImportCoordinator,
  type ImportJobRepository,
  ImportService,
  type ImportTransactionRunner,
  OnlineExportService,
  type PreservedChunkSource,
  type RulesAvailability,
  TemporaryPackageStore,
} from '@rpg/campaign-portability';
import { CampaignExporter, type CampaignRepository, type SystemCatalog } from '@rpg/campaigns';
import { type CharacterExporter, countCharacterRecords } from '@rpg/characters';
import { type ContentExporter, countContentRecords } from '@rpg/content';
import type { ImportableModule } from '@rpg/contracts';
import { countDiceRecords, type RollExporter } from '@rpg/dice';
import { countEncounterRecords, type EncounterExporter } from '@rpg/encounters';
import { countSessionRecords, type SessionExporter } from '@rpg/sessions';

/**
 * Feature 07 composition: the registered P0 contributors and their placement. Adding a content
 * feature to the package is one `register` call here; the orchestrator never changes.
 *
 * - `campaign` (feature 02): campaign root entry, plus the exact pins for the locks. Its
 *   transaction-aware import is the separate `CampaignImporter` (it needs the catalog, settings
 *   registry and owner writer), registered as the module's `importer`.
 * - `attachments` (feature 05): manifest only, `attachments-manifest/attachments.json`. It
 *   implements `ImportableModule` itself and restores nothing in P0 (no binaries).
 * - `content` (feature 16): entities and relationships, `entities/content.json`, Visibility as
 *   stored; personal notes are never exported (D-12).
 * - `dice_rolls` (feature 09): roll history, `entities/dice_rolls.json`, Visibility as stored.
 * - `sessions` (feature 18): sessions, GM notes, and log entries, `entities/sessions.json`.
 * - `encounters` (feature 19): encounters, GM notes, participants, and instance states,
 *   `entities/encounters.json`.
 */
export function createExportRegistry(input: {
  readonly campaigns: CampaignExporter;
  readonly attachments: AttachmentManifestExporter;
  readonly content: ContentExporter;
  readonly rolls: RollExporter;
  readonly characters: CharacterExporter;
  readonly sessions?: SessionExporter;
  readonly encounters?: EncounterExporter;
  readonly campaignImporter?: ImportableModule;
}): ExportRegistry {
  const registry = new ExportRegistry()
    .register(input.campaigns, {
      placement: 'campaign',
      countRecords: () => 1,
      ...(input.campaignImporter === undefined ? {} : { importer: input.campaignImporter }),
    })
    .register(input.attachments, {
      placement: 'attachments-manifest',
      countRecords: (payload) => (payload as AttachmentManifest).entries.length,
    })
    .register(input.content, { placement: 'entities', countRecords: countContentRecords })
    .register(input.rolls, { placement: 'entities', countRecords: countDiceRecords })
    .register(input.characters, { placement: 'entities', countRecords: countCharacterRecords });
  if (input.sessions !== undefined) {
    registry.register(input.sessions, {
      placement: 'entities',
      countRecords: countSessionRecords,
    });
  }
  return input.encounters === undefined
    ? registry
    : registry.register(input.encounters, {
        placement: 'entities',
        countRecords: countEncounterRecords,
      });
}

export function createOnlineExport(input: {
  readonly campaigns: Pick<CampaignRepository, 'get'>;
  readonly attachments: Pick<AttachmentRepository, 'listReadyInCampaign'>;
  /** Feature 16 contributor over its own repositories (built by the composition root). */
  readonly content: ContentExporter;
  /** Feature 09 contributor over its own repository. */
  readonly rolls: RollExporter;
  /** Feature 15 contributor over its own repository. */
  readonly characters: CharacterExporter;
  /** Feature 18 contributor over its own repository. */
  readonly sessions?: SessionExporter;
  /** Feature 19 contributor over its own repository. */
  readonly encounters?: EncounterExporter;
  readonly jobs: ExportJobRepository;
  readonly applicationVersion: string;
  readonly files?: TemporaryPackageStore;
  /** Opaque chunks an earlier import preserved, re-emitted under `unknown/`. */
  readonly preserved?: PreservedChunkSource;
  readonly campaignImporter?: ImportableModule;
  readonly log?: { exportFailed(code: string, moduleId?: string): void };
}) {
  const campaignExporter = new CampaignExporter(input.campaigns);
  const registry = createExportRegistry({
    campaigns: campaignExporter,
    attachments: new AttachmentManifestExporter(input.attachments),
    content: input.content,
    rolls: input.rolls,
    characters: input.characters,
    ...(input.sessions === undefined ? {} : { sessions: input.sessions }),
    ...(input.encounters === undefined ? {} : { encounters: input.encounters }),
    ...(input.campaignImporter === undefined ? {} : { campaignImporter: input.campaignImporter }),
  });
  const files = input.files ?? new TemporaryPackageStore();
  const orchestrator = new ExportOrchestrator({
    registry,
    rules: campaignExporter,
    applicationVersion: input.applicationVersion,
    ...(input.preserved === undefined ? {} : { preserved: input.preserved }),
  });
  return {
    registry,
    files,
    service: new OnlineExportService({ jobs: input.jobs, orchestrator, files, log: input.log }),
  };
}

/**
 * Exact pinned rules context of a package against the installed catalog (feature 07 `_bdd.md`,
 * "An unavailable pinned system blocks before write"). Never a nearby or newer version.
 */
export function catalogRulesAvailability(
  catalog: Pick<SystemCatalog, 'resolveExact'>,
): RulesAvailability {
  return {
    unavailable: async (system, modules) => {
      const definition = await catalog.resolveExact({
        systemId: system.systemId,
        version: system.version,
      });
      if (definition === undefined) return { system, modules: [] };
      return {
        modules: modules.modules.filter(
          (pin) =>
            definition.compatibleModules.find((module) => module.id === pin.moduleId)?.version !==
            pin.version,
        ),
      };
    },
  };
}

/**
 * Feature 07 task 06: atomic import over the same registry as export. One transaction (feature
 * 07's) carries feature 02's campaign, feature 01's sole owner, every contributor and the
 * preserved chunks; `committed` runs only after commit (the `campaign.imported` audit event).
 */
export function createCampaignImport(input: {
  readonly registry: ExportRegistry;
  readonly catalog: Pick<SystemCatalog, 'resolveExact'>;
  readonly jobs: ImportJobRepository;
  readonly transactions: ImportTransactionRunner;
  readonly store: ImportCommitStore;
  readonly committed?: (input: { campaignId: string; userId: string }) => Promise<void>;
  readonly log?: { importFailed(code: string, moduleId?: string): void };
}): ImportService {
  return new ImportService({
    jobs: input.jobs,
    registry: input.registry,
    rules: catalogRulesAvailability(input.catalog),
    coordinator: new ImportCoordinator({ transactions: input.transactions, store: input.store }),
    ...(input.committed === undefined ? {} : { committed: input.committed }),
    ...(input.log === undefined ? {} : { log: input.log }),
  });
}

/**
 * Feature 05 retention seam: while an export of a campaign is requested or running, every
 * attachment of that campaign is retained (its tombstone is not purged mid-read).
 */
export function exportJobAttachmentReferences(
  jobs: Pick<ExportJobRepository, 'activeCampaignIds'>,
): RetainedAttachmentReferences {
  return {
    referenced: async (attachments) => {
      if (attachments.length === 0) return new Set();
      const active = await jobs.activeCampaignIds([
        ...new Set(attachments.map((row) => row.campaignId)),
      ]);
      return new Set(attachments.filter((row) => active.has(row.campaignId)).map((row) => row.id));
    },
  };
}

/**
 * Hard-deletes export (30 days) or import (90 days) job metadata past its retention. Counts only
 * are reported.
 */
export function startExportJobRetention(
  jobs: Pick<ExportJobRepository | ImportJobRepository, 'deleteExpired'>,
  intervalMs: number,
  report: (outcome: number | 'failed') => void,
): () => void {
  const run = () => {
    jobs.deleteExpired().then(report, () => report('failed'));
  };
  const timer = setInterval(run, intervalMs);
  (timer as { unref?: () => void }).unref?.();
  return () => clearInterval(timer);
}
