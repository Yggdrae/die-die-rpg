import {
  type EntityEnvelope,
  err,
  ok,
  type RepositoryError,
  type Result,
  type SyncedRepository,
} from '@rpg/contracts';
import type { CampaignContext, CampaignCreateInput, SystemDefinition } from './contracts.ts';
import { selectedModulePins, validateCampaignInput } from './domain.ts';

export interface CampaignReplica extends EntityEnvelope {
  readonly system: { readonly systemId: string; readonly version: string };
  readonly gameMode: string;
  readonly modulePins: readonly { readonly moduleId: string; readonly version: string }[];
  readonly settings: Readonly<Record<string, unknown>>;
  readonly causalGroupId: string;
  readonly pendingInvitationRoles: readonly ('gm' | 'assistant_gm' | 'player')[];
}

export interface OfflineInvitationQueue {
  queue(input: {
    readonly campaignId: string;
    readonly role: 'gm' | 'assistant_gm' | 'player';
    readonly causalGroupId: string;
  }): Promise<void>;
}

export class OfflineCampaignRepository {
  constructor(
    private readonly repository: SyncedRepository<CampaignReplica>,
    private readonly invitations: OfflineInvitationQueue,
  ) {}

  async create(
    userId: string,
    input: CampaignCreateInput,
    system: SystemDefinition,
    invitationRoles: readonly ('gm' | 'assistant_gm' | 'player')[] = [],
  ): Promise<Result<CampaignContext, 'invalid_aggregate' | RepositoryError>> {
    if (validateCampaignInput(input, system) !== undefined) return err('invalid_aggregate');
    const now = new Date().toISOString();
    const causalGroupId = crypto.randomUUID();
    const stored = await this.repository.upsert(
      {
        id: input.id,
        campaignId: input.id,
        type: 'campaign',
        name: input.name.trim(),
        tags: [],
        metadata: { description: input.description },
        visibility: { mode: 'everyone' },
        version: 1,
        createdAt: now,
        createdBy: userId,
        updatedAt: now,
        updatedBy: userId,
        system: input.system,
        gameMode: input.gameMode,
        modulePins: selectedModulePins(input.moduleIds, system.compatibleModules),
        settings: { system: structuredClone(input.options) },
        causalGroupId,
        pendingInvitationRoles: [...invitationRoles],
      },
      null,
    );
    if (!stored.ok) return stored;
    return ok(toContext(stored.value));
  }

  async getContext(campaignId: string): Promise<CampaignContext | undefined> {
    const found = await this.repository.get(campaignId);
    return found.ok && found.value.deletedAt === undefined ? toContext(found.value) : undefined;
  }

  async authorityAccepted(campaignId: string): Promise<void> {
    const record = await this.repository.get(campaignId);
    if (!record.ok || record.value.deletedAt !== undefined) return;
    for (const role of record.value.pendingInvitationRoles) {
      await this.invitations.queue({
        campaignId,
        role,
        causalGroupId: record.value.causalGroupId,
      });
    }
    if (record.value.pendingInvitationRoles.length > 0) {
      await this.repository.upsert(
        {
          ...record.value,
          pendingInvitationRoles: [],
          updatedAt: new Date().toISOString(),
        },
        record.value.version,
      );
    }
  }
}

function toContext(record: CampaignReplica): CampaignContext {
  return {
    campaignId: record.id,
    system: record.system,
    gameMode: record.gameMode,
    modulePins: [...record.modulePins],
    settings: structuredClone(record.settings),
  };
}
