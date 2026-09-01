import { type ActorRef, type AuditRecorder, err, ok, type Result } from '@rpg/contracts';
import type { CampaignMembershipWriter } from '@rpg/identity';
import type {
  CampaignContext,
  CampaignContextResolver,
  CampaignCreateInput,
  CampaignDetailsUpdateInput,
  CampaignSettingUpdateInput,
  CampaignSystemUpdateInput,
  CampaignView,
  SystemCatalog,
} from './contracts.ts';
import {
  type CampaignSettingRegistry,
  type CampaignValidationError,
  selectedModulePins,
  validateCampaignInput,
} from './domain.ts';

export type CampaignError =
  | CampaignValidationError
  | 'not_found_or_forbidden'
  | 'version_conflict'
  | 'campaign_conflict'
  | 'owner_conflict'
  | 'system_update_incompatible'
  | 'persistence_unavailable';

export interface CampaignRecord extends CampaignView {
  readonly createdBy: string;
  readonly deletedAt?: string;
}

export interface CampaignAccessPolicy {
  decide(
    actor: ActorRef,
    capability: 'read' | 'update' | 'delete' | 'update_system' | 'write_setting',
    namespace?: string,
  ): boolean;
}

export interface CampaignRepository {
  create(
    record: CampaignRecord,
    ownerWriter: CampaignMembershipWriter,
  ): Promise<
    Result<
      { readonly record: CampaignRecord; readonly created: boolean },
      'campaign_conflict' | 'owner_conflict' | 'persistence_unavailable'
    >
  >;
  get(campaignId: string): Promise<CampaignRecord | undefined>;
  list(campaignIds: readonly string[]): Promise<readonly CampaignRecord[]>;
  updateDetails(
    campaignId: string,
    input: CampaignDetailsUpdateInput,
    actorUserId: string,
  ): Promise<Result<CampaignRecord, 'not_found' | 'version_conflict' | 'persistence_unavailable'>>;
  updateSetting(
    campaignId: string,
    namespace: string,
    input: CampaignSettingUpdateInput,
    actorUserId: string,
    memberVisible: boolean,
  ): Promise<Result<CampaignRecord, 'not_found' | 'version_conflict' | 'persistence_unavailable'>>;
  updateSystemPin(
    campaignId: string,
    targetVersion: string,
    expectedVersion: number,
    actorUserId: string,
  ): Promise<Result<CampaignRecord, 'not_found' | 'version_conflict' | 'persistence_unavailable'>>;
  softDelete(
    campaignId: string,
    expectedVersion: number,
    actorUserId: string,
  ): Promise<Result<void, 'not_found' | 'version_conflict' | 'persistence_unavailable'>>;
}

export interface CampaignActorResolver {
  resolve(userId: string, campaignId: string): Promise<Result<ActorRef, 'membership_not_found'>>;
  listCampaignIds(userId: string): Promise<readonly string[]>;
}

export interface CampaignLog {
  auditDegraded(action: string, campaignId: string): void;
}

export class CampaignService implements CampaignContextResolver {
  constructor(
    private readonly repository: CampaignRepository,
    private readonly catalog: SystemCatalog,
    private readonly actors: CampaignActorResolver,
    private readonly ownerWriter: CampaignMembershipWriter,
    private readonly access: CampaignAccessPolicy,
    private readonly settings: CampaignSettingRegistry,
    private readonly audit: AuditRecorder,
    private readonly log: CampaignLog,
  ) {}

  async create(
    userId: string,
    input: CampaignCreateInput,
  ): Promise<Result<CampaignView, CampaignError>> {
    const system = await this.catalog.resolveExact(input.system);
    if (system === undefined) return err('system_unavailable');
    const invalid = validateCampaignInput(input, system);
    if (invalid !== undefined) return err(invalid);

    const now = new Date().toISOString();
    const record: CampaignRecord = {
      id: input.id,
      name: input.name.trim(),
      description: input.description,
      system: input.system,
      gameMode: input.gameMode,
      modulePins: [...selectedModulePins(input.moduleIds, system.compatibleModules)],
      settings: { system: structuredClone(input.options) },
      version: 1,
      createdAt: now,
      updatedAt: now,
      createdBy: userId,
    };
    const created = await this.repository.create(record, this.ownerWriter);
    if (!created.ok) return created;
    if (created.value.created) {
      await this.recordAudit('campaign.created', created.value.record, userId, undefined, {
        system: created.value.record.system,
      });
    }
    return ok(toView(created.value.record));
  }

  async list(userId: string): Promise<readonly CampaignView[]> {
    return (await this.repository.list(await this.actors.listCampaignIds(userId))).map(toView);
  }

  async get(userId: string, campaignId: string): Promise<Result<CampaignView, CampaignError>> {
    const authorized = await this.authorize(userId, campaignId, 'read');
    if (!authorized.ok) return authorized;
    const record = await this.repository.get(campaignId);
    return record === undefined || record.deletedAt !== undefined
      ? err('not_found_or_forbidden')
      : ok(toView(record));
  }

  async updateDetails(
    userId: string,
    campaignId: string,
    input: CampaignDetailsUpdateInput,
  ): Promise<Result<CampaignView, CampaignError>> {
    const authorized = await this.authorize(userId, campaignId, 'update');
    if (!authorized.ok) return authorized;
    const current = await this.repository.get(campaignId);
    if (current === undefined || current.deletedAt !== undefined)
      return err('not_found_or_forbidden');
    const updated = await this.repository.updateDetails(campaignId, input, userId);
    if (!updated.ok) return err(mapRepositoryError(updated.error));
    await this.recordAudit(
      'campaign.details_updated',
      updated.value,
      userId,
      { name: current.name, description: current.description },
      { name: updated.value.name, description: updated.value.description },
      authorized.value.role,
    );
    return ok(toView(updated.value));
  }

  async updateSetting(
    userId: string,
    campaignId: string,
    namespace: string,
    input: CampaignSettingUpdateInput,
  ): Promise<Result<CampaignView, CampaignError>> {
    const invalid = this.settings.validate(namespace, input.value);
    if (invalid !== undefined) return err(invalid);
    const registration = this.settings.get(namespace);
    if (registration === undefined) return err('unregistered_setting_namespace');
    const authorized = await this.authorize(userId, campaignId, 'write_setting', namespace);
    if (
      !authorized.ok ||
      authorized.value.role === 'observer' ||
      !registration.writableRoles.includes(authorized.value.role)
    ) {
      return err('not_found_or_forbidden');
    }
    const updated = await this.repository.updateSetting(
      campaignId,
      namespace,
      input,
      userId,
      registration.memberVisible,
    );
    if (!updated.ok) return err(mapRepositoryError(updated.error));
    if (registration.memberVisible) {
      await this.recordAudit(
        'campaign.setting_changed',
        updated.value,
        userId,
        undefined,
        {
          namespace,
        },
        authorized.value.role,
      );
    }
    return ok(toView(updated.value));
  }

  async updateSystem(
    userId: string,
    campaignId: string,
    input: CampaignSystemUpdateInput,
  ): Promise<Result<CampaignView, CampaignError>> {
    const authorized = await this.authorize(userId, campaignId, 'update_system');
    if (!authorized.ok) return authorized;
    const current = await this.repository.get(campaignId);
    if (current === undefined || current.deletedAt !== undefined)
      return err('not_found_or_forbidden');
    const target = await this.catalog.resolveExact({
      systemId: current.system.systemId,
      version: input.targetVersion,
    });
    if (target === undefined) return err('system_unavailable');
    if (!target.gameModes.some((mode) => mode.id === current.gameMode)) {
      return err('system_update_incompatible');
    }
    const systemSettings = current.settings.system;
    if (
      systemSettings !== undefined &&
      (typeof systemSettings !== 'object' ||
        systemSettings === null ||
        Array.isArray(systemSettings))
    ) {
      return err('system_update_incompatible');
    }
    const compatibilityInput: CampaignCreateInput = {
      id: current.id,
      system: target.summary.ref,
      gameMode: current.gameMode,
      options: (systemSettings ?? {}) as Record<string, unknown>,
      moduleIds: current.modulePins.map((pin) => pin.moduleId),
      name: current.name,
      description: current.description,
    };
    if (validateCampaignInput(compatibilityInput, target) !== undefined) {
      return err('system_update_incompatible');
    }
    const updated = await this.repository.updateSystemPin(
      campaignId,
      input.targetVersion,
      input.expectedVersion,
      userId,
    );
    if (!updated.ok) return err(mapRepositoryError(updated.error));
    await this.recordAudit(
      'campaign.system_updated',
      updated.value,
      userId,
      { system: current.system },
      {
        system: updated.value.system,
      },
    );
    return ok(toView(updated.value));
  }

  async delete(
    userId: string,
    campaignId: string,
    expectedVersion: number,
  ): Promise<Result<void, CampaignError>> {
    const authorized = await this.authorize(userId, campaignId, 'delete');
    if (!authorized.ok) return authorized;
    const current = await this.repository.get(campaignId);
    if (current === undefined || current.deletedAt !== undefined)
      return err('not_found_or_forbidden');
    const deleted = await this.repository.softDelete(campaignId, expectedVersion, userId);
    if (!deleted.ok) return err(mapRepositoryError(deleted.error));
    await this.recordAudit('campaign.deleted', current, userId);
    return ok(undefined);
  }

  async resolve(userId: string, campaignId: string): Promise<CampaignContext | undefined> {
    const read = await this.get(userId, campaignId);
    if (!read.ok) return undefined;
    if ((await this.catalog.resolveExact(read.value.system)) === undefined) return undefined;
    return {
      campaignId: read.value.id,
      system: read.value.system,
      gameMode: read.value.gameMode,
      modulePins: read.value.modulePins,
      settings: read.value.settings,
    };
  }

  private async authorize(
    userId: string,
    campaignId: string,
    capability: Parameters<CampaignAccessPolicy['decide']>[1],
    namespace?: string,
  ): Promise<Result<ActorRef, 'not_found_or_forbidden'>> {
    const actor = await this.actors.resolve(userId, campaignId);
    if (!actor.ok || !this.access.decide(actor.value, capability, namespace)) {
      return err('not_found_or_forbidden');
    }
    return actor;
  }

  private async recordAudit(
    action: string,
    campaign: CampaignRecord,
    userId: string,
    before?: Record<string, unknown>,
    after?: Record<string, unknown>,
    role: ActorRef['role'] = 'owner',
  ): Promise<void> {
    try {
      await this.audit.record({
        campaignId: campaign.id,
        actor: { userId, campaignId: campaign.id, role },
        action,
        targetType: 'campaign',
        targetId: campaign.id,
        before,
        after,
        at: new Date().toISOString(),
        private: false,
      });
    } catch {
      this.log.auditDegraded(action, campaign.id);
    }
  }
}

function mapRepositoryError(error: 'not_found' | 'version_conflict' | 'persistence_unavailable') {
  return error === 'not_found' ? 'not_found_or_forbidden' : error;
}

function toView(record: CampaignRecord): CampaignView {
  return {
    id: record.id,
    name: record.name,
    description: record.description,
    system: record.system,
    gameMode: record.gameMode,
    modulePins: record.modulePins,
    settings: record.settings,
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}
