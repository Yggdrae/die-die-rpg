import { err, ok } from '@rpg/contracts';
import type { CampaignMembershipWriter } from '@rpg/identity';
import type { CampaignRecord, CampaignRepository } from './application.ts';
import type { CampaignDetailsUpdateInput, CampaignSettingUpdateInput } from './contracts.ts';

export class InMemoryCampaignRepository implements CampaignRepository {
  readonly #campaigns = new Map<string, CampaignRecord>();
  readonly #memberships = new Map<string, Set<string>>();
  readonly #settingVersions = new Map<string, number>();
  readonly #settingVisibility = new Map<string, boolean>();

  async create(record: CampaignRecord, ownerWriter: CampaignMembershipWriter) {
    const current = this.#campaigns.get(record.id);
    if (current !== undefined) {
      return sameAggregate(current, record)
        ? ok({ record: structuredClone(current), created: false })
        : err<'campaign_conflict'>('campaign_conflict');
    }
    const inserted = await ownerWriter.createOwner(
      { userId: record.createdBy, campaignId: record.id },
      {
        handle: {
          insertOwner: async (input: { readonly userId: string; readonly campaignId: string }) => {
            const members = this.#memberships.get(input.campaignId) ?? new Set<string>();
            if (members.size > 0) return err('owner_conflict');
            members.add(input.userId);
            this.#memberships.set(input.campaignId, members);
            return ok({ ...input, role: 'owner' as const });
          },
        },
      },
    );
    if (!inserted.ok) return err<'owner_conflict'>('owner_conflict');
    this.#campaigns.set(record.id, structuredClone(record));
    for (const namespace of Object.keys(record.settings)) {
      this.#settingVersions.set(settingKey(record.id, namespace), 1);
    }
    return ok({ record: structuredClone(record), created: true });
  }

  async get(campaignId: string) {
    const record = this.#campaigns.get(campaignId);
    return record === undefined ? undefined : structuredClone(record);
  }

  async list(campaignIds: readonly string[]) {
    const visible = new Set(campaignIds);
    return [...this.#campaigns.values()]
      .filter((campaign) => campaign.deletedAt === undefined && visible.has(campaign.id))
      .map((campaign) => structuredClone(campaign));
  }

  async updateDetails(campaignId: string, input: CampaignDetailsUpdateInput, _actorUserId: string) {
    return this.update(campaignId, input.expectedVersion, (current) => ({
      ...current,
      name: input.name.trim(),
      description: input.description,
    }));
  }

  async updateSetting(
    campaignId: string,
    namespace: string,
    input: CampaignSettingUpdateInput,
    _actorUserId: string,
    memberVisible: boolean,
  ) {
    const current = this.#campaigns.get(campaignId);
    if (current === undefined || current.deletedAt !== undefined)
      return err<'not_found'>('not_found');
    const key = settingKey(campaignId, namespace);
    const settingVersion = this.#settingVersions.get(key);
    if (settingVersion === undefined) {
      if (input.expectedVersion !== null) return err<'not_found'>('not_found');
    } else if (input.expectedVersion !== settingVersion) {
      return err<'version_conflict'>('version_conflict');
    }
    const updated = await this.update(campaignId, current.version, (record) => ({
      ...record,
      settings: { ...record.settings, [namespace]: structuredClone(input.value) },
    }));
    if (updated.ok) {
      this.#settingVersions.set(key, (settingVersion ?? 0) + 1);
      this.#settingVisibility.set(key, memberVisible);
    }
    return updated;
  }

  async getSetting(campaignId: string, namespace: string) {
    const version = this.#settingVersions.get(settingKey(campaignId, namespace));
    const campaign = this.#campaigns.get(campaignId);
    if (version === undefined || campaign === undefined) return undefined;
    return {
      value: structuredClone(campaign.settings[namespace]),
      version,
      // Creation stores the system namespace member-visible, as the PostgreSQL repository does.
      memberVisible: this.#settingVisibility.get(settingKey(campaignId, namespace)) ?? true,
    };
  }

  async updateSystemPin(
    campaignId: string,
    targetVersion: string,
    expectedVersion: number,
    _actorUserId: string,
  ) {
    return this.update(campaignId, expectedVersion, (current) => ({
      ...current,
      system: { ...current.system, version: targetVersion },
    }));
  }

  async softDelete(campaignId: string, expectedVersion: number, _actorUserId: string) {
    const updated = await this.update(campaignId, expectedVersion, (current) => ({
      ...current,
      deletedAt: new Date().toISOString(),
    }));
    return updated.ok ? ok(undefined) : updated;
  }

  private async update(
    campaignId: string,
    expectedVersion: number,
    change: (record: CampaignRecord) => CampaignRecord,
  ) {
    const current = this.#campaigns.get(campaignId);
    if (current === undefined || current.deletedAt !== undefined)
      return err<'not_found'>('not_found');
    if (current.version !== expectedVersion) return err<'version_conflict'>('version_conflict');
    const updated = {
      ...change(structuredClone(current)),
      version: current.version + 1,
      updatedAt: new Date().toISOString(),
    };
    this.#campaigns.set(campaignId, updated);
    return ok(structuredClone(updated));
  }
}

function settingKey(campaignId: string, namespace: string): string {
  return `${campaignId}\u0000${namespace}`;
}

function sameAggregate(left: CampaignRecord, right: CampaignRecord): boolean {
  return (
    JSON.stringify({ ...left, createdAt: '', updatedAt: '' }) ===
    JSON.stringify({ ...right, createdAt: '', updatedAt: '' })
  );
}
