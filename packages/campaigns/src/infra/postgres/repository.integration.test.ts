import { afterAll, describe, expect, test } from 'bun:test';
import { PostgresCampaignMembershipWriter } from '@rpg/identity';
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
  test('campaign aggregate and one owner commit atomically and retry idempotently', async () => {
    if (connection === undefined) return;
    const userId = crypto.randomUUID();
    const campaignId = crypto.randomUUID();
    await connection.db.execute(sql`
      insert into identity_users
        (id, username_display, username_normalized, created_at, updated_at)
      values
        (${userId}, ${`User_${userId.slice(0, 8)}`}, ${`user_${userId.slice(0, 8)}`}, now(), now())
    `);
    const now = new Date().toISOString();
    const record: CampaignRecord = {
      id: campaignId,
      name: 'Road Game',
      description: '',
      system: { systemId: 'fixture-system', version: '0.1.0' },
      gameMode: 'standard',
      modulePins: [],
      settings: {},
      version: 1,
      createdAt: now,
      updatedAt: now,
      createdBy: userId,
    };
    const repository = new PostgresCampaignRepository(connection.db);
    const writer = new PostgresCampaignMembershipWriter();
    expect((await repository.create(record, writer)).ok).toBe(true);
    expect((await repository.create(record, writer)).ok).toBe(true);
    const [owners] = await connection.db.execute<{ count: number }>(sql`
      select count(*)::int as count
      from identity_campaign_memberships
      where campaign_id = ${campaignId} and role = 'owner' and removed_at is null
    `);
    expect(owners?.count).toBe(1);
  });

  test('deferred constraint rejects an ownerless committed campaign', async () => {
    if (connection === undefined) return;
    const userId = crypto.randomUUID();
    const campaignId = crypto.randomUUID();
    await connection.db.execute(sql`
      insert into identity_users
        (id, username_display, username_normalized, created_at, updated_at)
      values
        (${userId}, ${`User_${userId.slice(0, 8)}`}, ${`user_${userId.slice(0, 8)}`}, now(), now())
    `);
    await expect(
      connection.db.transaction(async (transaction) => {
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
      }),
    ).rejects.toThrow();
  });
});
