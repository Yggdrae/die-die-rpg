import { afterAll, describe, expect, test } from 'bun:test';
import { err } from '@rpg/contracts';
import { type CampaignMembershipWriter, PostgresCampaignMembershipWriter } from '@rpg/identity';
import { sql } from 'drizzle-orm';
import type { CampaignRecord } from '../../application.ts';
import { connectCampaignDatabase, PostgresCampaignRepository } from './repository.ts';
import { campaignSystemPins, campaigns } from './schema.ts';

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const candidate = databaseUrl === undefined ? undefined : connectCampaignDatabase(databaseUrl);
const connection = await (async () => {
  if (candidate === undefined) return undefined;
  try {
    await candidate.db.execute(sql`select 1`);
    return candidate;
  } catch {
    await candidate.close();
    return undefined;
  }
})();

afterAll(async () => connection?.close());

describe.skipIf(connection === undefined)('PostgreSQL campaign invariants', () => {
  async function insertUser(): Promise<string> {
    if (connection === undefined) throw new Error('database unavailable');
    const userId = crypto.randomUUID();
    await connection.db.execute(sql`
      insert into identity_users
        (id, username_display, username_normalized, created_at, updated_at)
      values
        (${userId}, ${`User_${userId.slice(0, 8)}`}, ${`user_${userId.slice(0, 8)}`}, now(), now())
    `);
    return userId;
  }

  function aggregate(userId: string): CampaignRecord {
    const now = new Date().toISOString();
    return {
      id: crypto.randomUUID(),
      name: 'Road Game',
      description: '',
      system: { systemId: 'fixture-system', version: '0.1.0' },
      gameMode: 'standard',
      modulePins: [{ moduleId: 'fixture-module', version: '1.0.0' }],
      settings: { 'fixture.rules': { zeta: 1, alpha: true } },
      version: 1,
      createdAt: now,
      updatedAt: now,
      createdBy: userId,
    };
  }

  async function counts(campaignId: string) {
    if (connection === undefined) throw new Error('database unavailable');
    const [row] = await connection.db.execute<{
      campaigns: number;
      systemPins: number;
      modulePins: number;
      settings: number;
      owners: number;
    }>(sql`
      select
        (select count(*)::int from campaigns where id = ${campaignId}) as "campaigns",
        (select count(*)::int from campaign_system_pins where campaign_id = ${campaignId}) as "systemPins",
        (select count(*)::int from campaign_module_pins where campaign_id = ${campaignId}) as "modulePins",
        (select count(*)::int from campaign_settings where campaign_id = ${campaignId}) as "settings",
        (select count(*)::int from identity_campaign_memberships
          where campaign_id = ${campaignId} and role = 'owner' and removed_at is null) as "owners"
    `);
    return row;
  }

  test('campaign aggregate and one owner commit atomically and retry idempotently', async () => {
    if (connection === undefined) return;
    const record = aggregate(await insertUser());
    const repository = new PostgresCampaignRepository(connection.db);
    const writer = new PostgresCampaignMembershipWriter();
    const first = await repository.create(record, writer);
    expect(first.ok && first.value.created).toBe(true);
    const retry = await repository.create(record, writer);
    expect(retry.ok && !retry.value.created).toBe(true);
    expect(await counts(record.id)).toEqual({
      campaigns: 1,
      systemPins: 1,
      modulePins: 1,
      settings: 1,
      owners: 1,
    });
    expect(await repository.create({ ...record, name: 'Other Game' }, writer)).toEqual({
      ok: false,
      error: 'campaign_conflict',
    });
  });

  test('owner failure rolls back every campaign row', async () => {
    if (connection === undefined) return;
    const record = aggregate(await insertUser());
    const failingWriter: CampaignMembershipWriter = {
      createOwner: async () => err('owner_conflict'),
    };
    expect(
      await new PostgresCampaignRepository(connection.db).create(record, failingWriter),
    ).toEqual({ ok: false, error: 'owner_conflict' });
    expect(await counts(record.id)).toEqual({
      campaigns: 0,
      systemPins: 0,
      modulePins: 0,
      settings: 0,
      owners: 0,
    });
  });

  test('concurrent creation of one client ID yields one campaign and one owner', async () => {
    if (connection === undefined) return;
    const record = aggregate(await insertUser());
    const repository = new PostgresCampaignRepository(connection.db);
    const writer = new PostgresCampaignMembershipWriter();
    const results = await Promise.all([
      repository.create(record, writer),
      repository.create(record, writer),
      repository.create(record, writer),
    ]);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(results.filter((result) => result.ok && result.value.created)).toHaveLength(1);
    expect(await counts(record.id)).toEqual({
      campaigns: 1,
      systemPins: 1,
      modulePins: 1,
      settings: 1,
      owners: 1,
    });
  });

  test('deferred constraint rejects an ownerless committed campaign', async () => {
    if (connection === undefined) return;
    const userId = await insertUser();
    const campaignId = crypto.randomUUID();
    // Capture the rejection explicitly: Bun's `expect(promise).rejects` stalls postgres.js I/O.
    const failure = await connection.db
      .transaction(async (transaction) => {
        await transaction.insert(campaigns).values({
          id: campaignId,
          name: 'Ownerless',
          gameMode: 'standard',
          createdBy: userId,
        });
        await transaction.insert(campaignSystemPins).values({
          campaignId,
          systemId: 'fixture-system',
          systemVersion: '0.1.0',
        });
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(failure).toMatchObject({
      code: '23514',
      constraint_name: 'campaigns_exactly_one_active_owner',
    });
    expect((await counts(campaignId))?.campaigns).toBe(0);
  });

  test('settings carry their own version independent of the campaign version', async () => {
    if (connection === undefined) return;
    const record = aggregate(await insertUser());
    const repository = new PostgresCampaignRepository(connection.db);
    expect((await repository.create(record, new PostgresCampaignMembershipWriter())).ok).toBe(true);
    expect(await repository.getSetting(record.id, 'fixture.rules')).toEqual({
      value: { zeta: 1, alpha: true },
      version: 1,
      memberVisible: true,
    });
    expect(await repository.getSetting(record.id, 'feature.weather')).toBeUndefined();
    const write = (value: unknown, expectedVersion: number | null) =>
      repository.updateSetting(
        record.id,
        'feature.weather',
        { value, expectedVersion },
        record.createdBy,
        true,
      );
    expect(await write({ enabled: true }, 1)).toEqual({ ok: false, error: 'not_found' });
    const inserted = await write({ enabled: true }, null);
    expect(inserted.ok && inserted.value.version).toBe(2);
    expect(await write({ enabled: false }, null)).toEqual({
      ok: false,
      error: 'version_conflict',
    });
    expect((await write({ enabled: false }, 1)).ok).toBe(true);
    expect(await write({ enabled: true }, 1)).toEqual({ ok: false, error: 'version_conflict' });
    expect(await repository.getSetting(record.id, 'feature.weather')).toEqual({
      value: { enabled: false },
      version: 2,
      memberVisible: true,
    });
  });

  test('soft-deleted campaign is exempt while active campaigns stay owned', async () => {
    if (connection === undefined) return;
    const record = aggregate(await insertUser());
    const repository = new PostgresCampaignRepository(connection.db);
    expect((await repository.create(record, new PostgresCampaignMembershipWriter())).ok).toBe(true);
    expect(await repository.softDelete(record.id, 1, record.createdBy)).toEqual({
      ok: true,
      value: undefined,
    });
    expect((await counts(record.id))?.owners).toBe(1);
  });
});
