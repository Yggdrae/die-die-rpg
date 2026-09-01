import { err, ok } from '@rpg/contracts';
import type { CampaignMembershipWriter, MembershipError } from '@rpg/identity';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import type { CampaignRecord, CampaignRepository } from '../../application.ts';
import type { CampaignDetailsUpdateInput, CampaignSettingUpdateInput } from '../../contracts.ts';
import {
  campaignModulePins,
  campaignSchema,
  campaignSettings,
  campaignSystemPins,
  campaigns,
} from './schema.ts';

type Database = PostgresJsDatabase<typeof campaignSchema>;
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

class OwnerFailure extends Error {
  constructor(readonly ownerError: MembershipError) {
    super(ownerError);
  }
}

export class PostgresCampaignRepository implements CampaignRepository {
  constructor(private readonly db: Database) {}

  async create(record: CampaignRecord, ownerWriter: CampaignMembershipWriter) {
    const existing = await this.get(record.id);
    if (existing !== undefined) {
      return sameAggregate(existing, record)
        ? ok({ record: existing, created: false })
        : err<'campaign_conflict'>('campaign_conflict');
    }
    try {
      const created = await this.db.transaction(async (transaction) => {
        const [campaign] = await transaction
          .insert(campaigns)
          .values({
            id: record.id,
            name: record.name,
            description: record.description,
            gameMode: record.gameMode,
            createdBy: record.createdBy,
          })
          .returning();
        if (campaign === undefined) throw new Error('campaign insert returned no row');
        await transaction.insert(campaignSystemPins).values({
          campaignId: record.id,
          systemId: record.system.systemId,
          systemVersion: record.system.version,
        });
        if (record.modulePins.length > 0) {
          await transaction.insert(campaignModulePins).values(
            record.modulePins.map((pin) => ({
              campaignId: record.id,
              moduleId: pin.moduleId,
              moduleVersion: pin.version,
            })),
          );
        }
        for (const [namespace, value] of Object.entries(record.settings)) {
          await transaction.insert(campaignSettings).values({
            campaignId: record.id,
            namespace,
            value,
            memberVisible: true,
            updatedBy: record.createdBy,
          });
        }
        const owner = await ownerWriter.createOwner(
          { campaignId: record.id, userId: record.createdBy },
          { handle: transaction },
        );
        if (!owner.ok) throw new OwnerFailure(owner.error);
        return this.load(record.id, transaction);
      });
      if (created === undefined) throw new Error('created campaign could not be loaded');
      return ok({ record: created, created: true });
    } catch (error) {
      if (error instanceof OwnerFailure) return err<'owner_conflict'>('owner_conflict');
      const concurrent = await this.get(record.id);
      if (concurrent !== undefined) {
        return sameAggregate(concurrent, record)
          ? ok({ record: concurrent, created: false })
          : err<'campaign_conflict'>('campaign_conflict');
      }
      return err<'persistence_unavailable'>('persistence_unavailable');
    }
  }

  get(campaignId: string) {
    return this.load(campaignId, this.db);
  }

  async list(campaignIds: readonly string[]) {
    const records = await Promise.all(campaignIds.map((campaignId) => this.get(campaignId)));
    return records.filter((record): record is CampaignRecord => record !== undefined);
  }

  async updateDetails(campaignId: string, input: CampaignDetailsUpdateInput, _actorUserId: string) {
    try {
      const changed = await this.db
        .update(campaigns)
        .set({
          name: input.name.trim(),
          description: input.description,
          version: sql`${campaigns.version} + 1`,
          updatedAt: sql`transaction_timestamp()`,
        })
        .where(
          and(
            eq(campaigns.id, campaignId),
            eq(campaigns.version, input.expectedVersion),
            isNull(campaigns.deletedAt),
          ),
        )
        .returning({ id: campaigns.id });
      if (changed.length === 0) return this.missingOrConflict(campaignId);
      const record = await this.get(campaignId);
      return record === undefined ? err<'not_found'>('not_found') : ok(record);
    } catch {
      return err<'persistence_unavailable'>('persistence_unavailable');
    }
  }

  async updateSetting(
    campaignId: string,
    namespace: string,
    input: CampaignSettingUpdateInput,
    actorUserId: string,
    memberVisible: boolean,
  ) {
    try {
      const result = await this.db.transaction(async (transaction) => {
        const [current] = await transaction
          .select({ version: campaignSettings.version })
          .from(campaignSettings)
          .where(
            and(
              eq(campaignSettings.campaignId, campaignId),
              eq(campaignSettings.namespace, namespace),
              isNull(campaignSettings.deletedAt),
            ),
          )
          .limit(1)
          .for('update');
        if (current === undefined) {
          if (input.expectedVersion !== null) return 'not_found' as const;
          await transaction.insert(campaignSettings).values({
            campaignId,
            namespace,
            value: input.value,
            memberVisible,
            updatedBy: actorUserId,
          });
        } else {
          if (input.expectedVersion !== current.version) return 'version_conflict' as const;
          await transaction
            .update(campaignSettings)
            .set({
              value: input.value,
              memberVisible,
              updatedBy: actorUserId,
              updatedAt: sql`transaction_timestamp()`,
              version: sql`${campaignSettings.version} + 1`,
            })
            .where(
              and(
                eq(campaignSettings.campaignId, campaignId),
                eq(campaignSettings.namespace, namespace),
              ),
            );
        }
        await transaction
          .update(campaigns)
          .set({
            version: sql`${campaigns.version} + 1`,
            updatedAt: sql`transaction_timestamp()`,
          })
          .where(and(eq(campaigns.id, campaignId), isNull(campaigns.deletedAt)));
        return this.load(campaignId, transaction);
      });
      if (result === 'not_found' || result === 'version_conflict') return err(result);
      return result === undefined ? err<'not_found'>('not_found') : ok(result);
    } catch {
      return err<'persistence_unavailable'>('persistence_unavailable');
    }
  }

  async updateSystemPin(
    campaignId: string,
    targetVersion: string,
    expectedVersion: number,
    _actorUserId: string,
  ) {
    try {
      const updated = await this.db.transaction(async (transaction) => {
        const changed = await transaction
          .update(campaigns)
          .set({
            version: sql`${campaigns.version} + 1`,
            updatedAt: sql`transaction_timestamp()`,
          })
          .where(
            and(
              eq(campaigns.id, campaignId),
              eq(campaigns.version, expectedVersion),
              isNull(campaigns.deletedAt),
            ),
          )
          .returning({ id: campaigns.id });
        if (changed.length === 0) return undefined;
        await transaction
          .update(campaignSystemPins)
          .set({ systemVersion: targetVersion, updatedAt: sql`transaction_timestamp()` })
          .where(eq(campaignSystemPins.campaignId, campaignId));
        return this.load(campaignId, transaction);
      });
      if (updated === undefined) return this.missingOrConflict(campaignId);
      return ok(updated);
    } catch {
      return err<'persistence_unavailable'>('persistence_unavailable');
    }
  }

  async softDelete(campaignId: string, expectedVersion: number, _actorUserId: string) {
    try {
      const changed = await this.db
        .update(campaigns)
        .set({
          deletedAt: sql`transaction_timestamp()`,
          updatedAt: sql`transaction_timestamp()`,
          version: sql`${campaigns.version} + 1`,
        })
        .where(
          and(
            eq(campaigns.id, campaignId),
            eq(campaigns.version, expectedVersion),
            isNull(campaigns.deletedAt),
          ),
        )
        .returning({ id: campaigns.id });
      if (changed.length === 0) return this.missingOrConflict(campaignId);
      return ok(undefined);
    } catch {
      return err<'persistence_unavailable'>('persistence_unavailable');
    }
  }

  private async missingOrConflict(campaignId: string) {
    return (await this.get(campaignId)) === undefined
      ? err<'not_found'>('not_found')
      : err<'version_conflict'>('version_conflict');
  }

  private async load(campaignId: string, executor: Database | Transaction) {
    const [base] = await executor
      .select({
        id: campaigns.id,
        name: campaigns.name,
        description: campaigns.description,
        gameMode: campaigns.gameMode,
        createdBy: campaigns.createdBy,
        version: campaigns.version,
        createdAt: campaigns.createdAt,
        updatedAt: campaigns.updatedAt,
        deletedAt: campaigns.deletedAt,
        systemId: campaignSystemPins.systemId,
        systemVersion: campaignSystemPins.systemVersion,
      })
      .from(campaigns)
      .innerJoin(campaignSystemPins, eq(campaignSystemPins.campaignId, campaigns.id))
      .where(eq(campaigns.id, campaignId))
      .limit(1);
    if (base === undefined) return undefined;
    const pins = await executor
      .select({ moduleId: campaignModulePins.moduleId, version: campaignModulePins.moduleVersion })
      .from(campaignModulePins)
      .where(eq(campaignModulePins.campaignId, campaignId))
      .orderBy(asc(campaignModulePins.moduleId));
    const settingRows = await executor
      .select({ namespace: campaignSettings.namespace, value: campaignSettings.value })
      .from(campaignSettings)
      .where(and(eq(campaignSettings.campaignId, campaignId), isNull(campaignSettings.deletedAt)));
    return {
      id: base.id,
      name: base.name,
      description: base.description,
      gameMode: base.gameMode,
      createdBy: base.createdBy,
      system: { systemId: base.systemId, version: base.systemVersion },
      modulePins: pins,
      settings: Object.fromEntries(settingRows.map((row) => [row.namespace, row.value])),
      version: base.version,
      createdAt: base.createdAt.toISOString(),
      updatedAt: base.updatedAt.toISOString(),
      ...(base.deletedAt === null ? {} : { deletedAt: base.deletedAt.toISOString() }),
    } satisfies CampaignRecord;
  }
}

function sameAggregate(left: CampaignRecord, right: CampaignRecord): boolean {
  return (
    JSON.stringify({ ...left, createdAt: '', updatedAt: '', version: 1 }) ===
    JSON.stringify({ ...right, createdAt: '', updatedAt: '', version: 1 })
  );
}

export function connectCampaignDatabase(connectionString: string) {
  const client = postgres(connectionString, { max: 10, prepare: false, onnotice: () => undefined });
  return {
    db: drizzle(client, { schema: campaignSchema, logger: false }),
    close: async () => client.end(),
  };
}
