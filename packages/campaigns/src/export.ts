import { check, type ExportableModule, type ExportChunk, err, SystemRef } from '@rpg/contracts';
import { type Static, Type } from '@sinclair/typebox';
import type { CampaignRecord } from './application.ts';

/**
 * Feature 02 contribution to feature 07's `.rpgpack` (`_db.md`, Lifecycle, Retention, and Export):
 * the campaign root entry of the package, with its fields, exact system and module pins, and settings.
 * It never carries an identifier of a member, the creator, owner credentials, sync bookkeeping or
 * a tombstone. The authorization decision (current `owner` or `gm`) is the host's, per request.
 *
 * Import cannot create a campaign through the frozen `import(campaignId, chunk)`: campaign creation
 * needs the transaction-aware import contract (feature 07 task 01), so it validates and reports.
 */

export const CAMPAIGN_EXPORT_MODULE_ID = 'campaign';
export const CAMPAIGN_CHUNK_VERSION = '1';

const Identifier = Type.String({ minLength: 1, maxLength: 100, pattern: '^[a-z0-9][a-z0-9._-]*$' });

export const CampaignChunk = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 120 }),
    description: Type.String({ maxLength: 10_000 }),
    system: SystemRef,
    gameMode: Identifier,
    modulePins: Type.Array(
      Type.Object(
        { moduleId: Identifier, version: Type.String({ minLength: 1 }) },
        { additionalProperties: false },
      ),
    ),
    settings: Type.Record(Type.String(), Type.Unknown()),
  },
  { additionalProperties: false, $id: 'CampaignChunkV1' },
);
export type CampaignChunk = Static<typeof CampaignChunk>;

export interface CampaignPins {
  readonly system: { readonly systemId: string; readonly version: string };
  readonly modules: readonly { readonly moduleId: string; readonly version: string }[];
}

/** What the contribution reads: the authority's repository, or the device replica when offline. */
export interface CampaignExportSource {
  get(
    campaignId: string,
  ): Promise<
    | Pick<
        CampaignRecord,
        'name' | 'description' | 'system' | 'gameMode' | 'modulePins' | 'settings' | 'deletedAt'
      >
    | undefined
  >;
}

/** The exact pins on the device, for the offline export (`authorized_campaigns`). */
export const CAMPAIGN_EXPORT_REPLICA_TABLES = {
  campaign_system_pins: {
    columns: { campaign_id: 'text', system_id: 'text', system_version: 'text' },
    indexes: { campaign: ['campaign_id'] },
  },
  campaign_module_pins: {
    columns: { campaign_id: 'text', module_id: 'text', module_version: 'text' },
    indexes: { campaign: ['campaign_id'] },
  },
} as const;

/** The queries of the device replica database. */
export interface CampaignReplicaReader {
  getOptional<T>(query: string, parameters: unknown[]): Promise<T | null>;
  getAll<T>(query: string, parameters: unknown[]): Promise<T[]>;
}

function settingValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    throw new Error('campaign_setting_invalid');
  }
}

/** Feature 07 task 05: the same contribution over the device replica. */
export function campaignReplicaSource(replica: CampaignReplicaReader): CampaignExportSource {
  return {
    get: async (campaignId) => {
      const [row, system, modules, settings] = await Promise.all([
        replica.getOptional<Record<string, unknown>>(
          'SELECT name, description, game_mode, deleted_at FROM campaigns WHERE id = ?',
          [campaignId],
        ),
        replica.getOptional<{ system_id: string; system_version: string }>(
          'SELECT system_id, system_version FROM campaign_system_pins WHERE campaign_id = ?',
          [campaignId],
        ),
        replica.getAll<{ module_id: string; module_version: string }>(
          'SELECT module_id, module_version FROM campaign_module_pins WHERE campaign_id = ? ORDER BY module_id',
          [campaignId],
        ),
        replica.getAll<{ namespace: string; value: unknown }>(
          'SELECT namespace, value FROM campaign_settings WHERE campaign_id = ? AND deleted_at IS NULL',
          [campaignId],
        ),
      ]);
      if (row === null || system === null) return undefined;
      return {
        name: String(row.name),
        description: String(row.description ?? ''),
        gameMode: String(row.game_mode),
        system: { systemId: system.system_id, version: system.system_version },
        modulePins: modules.map((pin) => ({
          moduleId: pin.module_id,
          version: pin.module_version,
        })),
        settings: Object.fromEntries(
          settings.map((setting) => [setting.namespace, settingValue(setting.value)]),
        ),
        ...(row.deleted_at === null || row.deleted_at === undefined
          ? {}
          : { deletedAt: String(row.deleted_at) }),
      };
    },
  };
}

/** The replica table holding the system pin, for a screen that watches it change. */
export const CAMPAIGN_PIN_REPLICA_TABLE = 'campaign_system_pins';

/** Feature 02's pinned system as the device replica holds it; `undefined` before the pin arrives. */
export async function campaignReplicaSystem(
  replica: CampaignReplicaReader,
  campaignId: string,
): Promise<{ readonly systemId: string; readonly version: string } | undefined> {
  const pin = await replica.getOptional<{ system_id: unknown; system_version: unknown }>(
    'SELECT system_id, system_version FROM campaign_system_pins WHERE campaign_id = ?',
    [campaignId],
  );
  if (typeof pin?.system_id !== 'string' || typeof pin.system_version !== 'string') {
    return undefined;
  }
  return { systemId: pin.system_id, version: pin.system_version };
}

/** Why the device cannot contribute this campaign, or `undefined` when it can. */
export async function campaignReplicaGap(
  replica: CampaignReplicaReader,
  campaignId: string,
): Promise<'campaign_not_on_device' | 'system_pins_not_replicated' | undefined> {
  const [row, pin] = await Promise.all([
    replica.getOptional<{ deleted_at: unknown }>('SELECT deleted_at FROM campaigns WHERE id = ?', [
      campaignId,
    ]),
    replica.getOptional<{ system_id: string }>(
      'SELECT system_id FROM campaign_system_pins WHERE campaign_id = ?',
      [campaignId],
    ),
  ]);
  if (row === null || (row.deleted_at ?? null) !== null) return 'campaign_not_on_device';
  return pin === null ? 'system_pins_not_replicated' : undefined;
}

export class CampaignExporter implements ExportableModule {
  readonly moduleId = CAMPAIGN_EXPORT_MODULE_ID;

  constructor(private readonly repository: CampaignExportSource) {}

  async export(campaignId: string): Promise<ExportChunk> {
    const campaign = await this.#live(campaignId);
    if (campaign === undefined) throw new Error('campaign_unavailable');
    const payload: CampaignChunk = {
      name: campaign.name,
      description: campaign.description,
      system: { systemId: campaign.system.systemId, version: campaign.system.version },
      gameMode: campaign.gameMode,
      modulePins: campaign.modulePins.map((pin) => ({
        moduleId: pin.moduleId,
        version: pin.version,
      })),
      settings: { ...campaign.settings },
    };
    return { moduleId: this.moduleId, chunkVersion: CAMPAIGN_CHUNK_VERSION, payload };
  }

  /** Exact pins for `system.lock`/`modules.lock` (`_prd.md` FR-005); never a newer version. */
  async pins(campaignId: string): Promise<CampaignPins | undefined> {
    const campaign = await this.#live(campaignId);
    return campaign === undefined
      ? undefined
      : {
          system: { systemId: campaign.system.systemId, version: campaign.system.version },
          modules: campaign.modulePins.map((pin) => ({
            moduleId: pin.moduleId,
            version: pin.version,
          })),
        };
  }

  async import(_campaignId: string, chunk: ExportChunk) {
    if (
      chunk.moduleId !== this.moduleId ||
      chunk.chunkVersion !== CAMPAIGN_CHUNK_VERSION ||
      !check(CampaignChunk, chunk.payload)
    ) {
      return err('campaign_chunk_invalid');
    }
    return err('campaign_import_requires_transaction_contract');
  }

  async #live(campaignId: string) {
    const campaign = await this.repository.get(campaignId);
    return campaign === undefined || campaign.deletedAt !== undefined ? undefined : campaign;
  }
}
