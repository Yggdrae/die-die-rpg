import {
  entitySchema,
  err,
  Id,
  ok,
  type RepositoryError,
  type Result,
  type SyncedRepository,
  SystemRef,
  type Version,
} from '@rpg/contracts';
import { type Static, Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type {
  CampaignContext,
  CampaignCreateInput,
  CampaignDetailsUpdateInput,
  SystemDefinition,
} from './contracts.ts';
import {
  type CampaignSettingRegistry,
  type CampaignValidationError,
  selectedModulePins,
  validateCampaignInput,
} from './domain.ts';

/** Feature/table keys shared by local replicas and the authority mutation appliers. */
export const CAMPAIGN_SYNC_FEATURE_ID = 'campaigns';
export const CAMPAIGN_REPLICA_TABLE = 'campaigns';
export const CAMPAIGN_SETTING_REPLICA_TABLE = 'campaign_settings';

const Identifier = Type.String({ minLength: 1, maxLength: 100, pattern: '^[a-z0-9][a-z0-9._-]*$' });
const InvitationRole = Type.Union([
  Type.Literal('gm'),
  Type.Literal('assistant_gm'),
  Type.Literal('player'),
]);
export type OfflineInvitationRole = Static<typeof InvitationRole>;

/**
 * Local campaign replica. The whole creation aggregate (details, exact system pin, module pins,
 * initial system settings, invitation intents) is one record, so it is written in one local
 * transaction and uploaded as one causally ordered mutation.
 */
export const CampaignReplicaSchema = entitySchema(
  {
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
    causalGroupId: Id,
    invitationIntents: Type.Array(
      Type.Object({ intentId: Id, role: InvitationRole }, { additionalProperties: false }),
    ),
  },
  { $id: 'CampaignReplica' },
);
export type CampaignReplica = Static<typeof CampaignReplicaSchema>;

/** Local namespaced setting replica; versioned independently of the campaign. */
export const CampaignSettingReplicaSchema = entitySchema(
  {
    namespace: Identifier,
    value: Type.Unknown(),
    memberVisible: Type.Boolean(),
  },
  { $id: 'CampaignSettingReplica' },
);
export type CampaignSettingReplica = Static<typeof CampaignSettingReplicaSchema>;

export interface OfflineInvitationQueue {
  /**
   * Queues one feature 01 invitation creation. Must be idempotent by `intentId`: acceptance may be
   * observed more than once (restart, reconnect).
   */
  queue(input: {
    readonly intentId: string;
    readonly campaignId: string;
    readonly role: OfflineInvitationRole;
    readonly causalGroupId: string;
  }): Promise<void>;
}

export type OfflineCampaignError =
  | CampaignValidationError
  | 'invalid_aggregate'
  | 'not_found'
  | RepositoryError;

export class OfflineCampaignRepository {
  constructor(
    private readonly campaigns: SyncedRepository<CampaignReplica>,
    private readonly settings: SyncedRepository<CampaignSettingReplica>,
    private readonly invitations: OfflineInvitationQueue,
    private readonly settingRegistry: CampaignSettingRegistry,
    private readonly clock: () => Date = () => new Date(),
    private readonly createId: () => string = () => crypto.randomUUID(),
  ) {}

  /** Records the creation aggregate locally against a locally available system definition. */
  async create(
    userId: string,
    input: CampaignCreateInput,
    system: SystemDefinition,
    invitationRoles: readonly OfflineInvitationRole[] = [],
  ): Promise<Result<CampaignContext, OfflineCampaignError>> {
    const invalid = validateCampaignInput(input, system);
    if (invalid !== undefined) return err(invalid);
    const now = this.clock().toISOString();
    const replica: CampaignReplica = {
      id: input.id,
      campaignId: input.id,
      type: 'campaign',
      name: input.name.trim(),
      tags: [],
      metadata: {},
      visibility: { mode: 'everyone' },
      version: 1,
      createdAt: now,
      createdBy: userId,
      updatedAt: now,
      updatedBy: userId,
      description: input.description,
      system: { ...input.system },
      gameMode: input.gameMode,
      modulePins: [...selectedModulePins(input.moduleIds, system.compatibleModules)],
      settings: { system: structuredClone(input.options) },
      causalGroupId: this.createId(),
      invitationIntents: invitationRoles.map((role) => ({ intentId: this.createId(), role })),
    };
    if (!Value.Check(CampaignReplicaSchema, replica)) return err('invalid_aggregate');
    const stored = await this.campaigns.upsert(replica, null);
    if (!stored.ok) return stored;
    return ok(toContext(stored.value, []));
  }

  async get(campaignId: string): Promise<CampaignReplica | undefined> {
    const found = await this.campaigns.get(campaignId);
    return found.ok && found.value.deletedAt === undefined ? found.value : undefined;
  }

  /** Local campaign context; tombstoned or purged campaigns resolve nothing. */
  async getContext(campaignId: string): Promise<CampaignContext | undefined> {
    const campaign = await this.get(campaignId);
    if (campaign === undefined) return undefined;
    const settings = await this.settings.list(campaignId);
    return toContext(campaign, settings.ok ? settings.value : []);
  }

  async updateDetails(
    userId: string,
    campaignId: string,
    input: CampaignDetailsUpdateInput,
  ): Promise<Result<CampaignReplica, OfflineCampaignError>> {
    const current = await this.get(campaignId);
    if (current === undefined) return err('not_found');
    const name = input.name.trim();
    if (name.length === 0) return err('invalid_campaign_details');
    const next: CampaignReplica = {
      ...current,
      name,
      description: input.description,
      updatedAt: this.clock().toISOString(),
      updatedBy: userId,
    };
    if (!Value.Check(CampaignReplicaSchema, next)) return err('invalid_campaign_details');
    return this.campaigns.upsert(next, input.expectedVersion);
  }

  /** Versioned namespaced setting write; `expectedVersion` is the setting record version. */
  async writeSetting(
    userId: string,
    campaignId: string,
    namespace: string,
    value: unknown,
    expectedVersion: Version | null,
  ): Promise<Result<CampaignSettingReplica, OfflineCampaignError>> {
    const invalid = this.settingRegistry.validate(namespace, value);
    if (invalid !== undefined) return err(invalid);
    const registration = this.settingRegistry.get(namespace);
    if (registration === undefined) return err('unregistered_setting_namespace');
    if ((await this.get(campaignId)) === undefined) return err('not_found');
    const listed = await this.settings.list(campaignId);
    if (!listed.ok) return listed;
    const current = listed.value.find((setting) => setting.namespace === namespace);
    const now = this.clock().toISOString();
    const next: CampaignSettingReplica = {
      ...(current ?? {
        id: this.createId(),
        campaignId,
        type: 'campaign_setting',
        name: namespace,
        tags: [],
        metadata: {},
        visibility: { mode: 'everyone' as const },
        version: 1,
        createdAt: now,
        createdBy: userId,
      }),
      namespace,
      value: structuredClone(value),
      memberVisible: registration.memberVisible,
      updatedAt: now,
      updatedBy: userId,
    };
    if (!Value.Check(CampaignSettingReplicaSchema, next)) return err('invalid_setting');
    return this.settings.upsert(next, current === undefined ? null : expectedVersion);
  }

  async delete(
    campaignId: string,
    expectedVersion: Version,
  ): Promise<Result<void, OfflineCampaignError>> {
    return this.campaigns.softDelete(campaignId, expectedVersion);
  }

  /**
   * Called once the authority accepted the creation mutation. Only then are invitation intents
   * handed to feature 01; before that no invitation exists or is reported delivered.
   */
  async authorityAccepted(campaignId: string): Promise<void> {
    const campaign = await this.get(campaignId);
    if (campaign === undefined) return;
    for (const intent of campaign.invitationIntents) {
      await this.invitations.queue({
        intentId: intent.intentId,
        campaignId,
        role: intent.role,
        causalGroupId: campaign.causalGroupId,
      });
    }
  }
}

/** Maps a creation replica to the authority creation input (same client ID and pins). */
export function campaignCreateInputFromReplica(replica: CampaignReplica): CampaignCreateInput {
  const options = replica.settings.system;
  return {
    id: replica.id,
    system: { ...replica.system },
    gameMode: replica.gameMode,
    options:
      options !== null && typeof options === 'object' && !Array.isArray(options)
        ? structuredClone(options as Record<string, unknown>)
        : {},
    moduleIds: replica.modulePins.map((pin) => pin.moduleId),
    name: replica.name,
    description: replica.description,
  };
}

function toContext(
  campaign: CampaignReplica,
  settings: readonly CampaignSettingReplica[],
): CampaignContext {
  const merged: Record<string, unknown> = structuredClone(campaign.settings);
  for (const setting of settings) {
    if (setting.deletedAt === undefined) merged[setting.namespace] = structuredClone(setting.value);
  }
  return {
    campaignId: campaign.id,
    system: { ...campaign.system },
    gameMode: campaign.gameMode,
    modulePins: campaign.modulePins.map((pin) => ({ ...pin })),
    settings: merged,
  };
}
