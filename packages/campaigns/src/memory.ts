import { err, ok } from '@rpg/contracts';
import type { CampaignMembershipWriter } from '@rpg/identity';
import type { CampaignRecord, CampaignRepository } from './application.ts';
import type { CampaignDetailsUpdateInput, CampaignSettingUpdateInput } from './contracts.ts';

export class InMemoryCampaignRepository implements CampaignRepository {
  readonly #campaigns = new Map<string, CampaignRecord>();
  readonly #memberships = new Map<string, Set<string>>();

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
    _memberVisible: boolean,
  ) {
    const current = this.#campaigns.get(campaignId);
    if (current === undefined || current.deletedAt !== undefined)
      return err<'not_found'>('not_found');
    const expectedVersion = input.expectedVersion ?? current.version;
    return this.update(campaignId, expectedVersion, (record) => ({
      ...record,
      settings: { ...record.settings, [namespace]: structuredClone(input.value) },
    }));
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

function sameAggregate(left: CampaignRecord, right: CampaignRecord): boolean {
  return (
    JSON.stringify({ ...left, createdAt: '', updatedAt: '' }) ===
    JSON.stringify({ ...right, createdAt: '', updatedAt: '' })
  );
}
