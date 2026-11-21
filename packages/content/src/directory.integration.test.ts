import { afterAll, describe, expect, test } from 'bun:test';
import { AuthorizationService, ResourcePolicyRegistry } from '@rpg/authorization';
import { err, ok, type Role, type Visibility } from '@rpg/contracts';
import { sql } from 'drizzle-orm';
import { EntityDirectory } from './directory.ts';
import { connectContentDatabase, PostgresEntityRepository } from './infra/postgres/repository.ts';
import {
  CAMPAIGN_ENTITY_POLICY,
  ENTITY_RELATIONSHIP_POLICY,
  PERSONAL_NOTE_POLICY,
} from './policies.ts';

/**
 * Feature 16 task 10 on PostgreSQL: the published directory over the real repository and feature 04
 * decisions. Rows are deleted afterwards.
 */

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const candidate = databaseUrl === undefined ? undefined : connectContentDatabase(databaseUrl);
const connection = await (async () => {
  if (candidate === undefined) return undefined;
  try {
    await candidate.db.execute(sql`select 1 from content_entities limit 1`);
    return candidate;
  } catch {
    await candidate.close();
    return undefined;
  }
})();

const campaignId = crypto.randomUUID();
afterAll(async () => {
  if (connection === undefined) return;
  await connection.db.execute(
    sql`delete from content_personal_notes where campaign_id = ${campaignId}::uuid`,
  );
  await connection.db.execute(
    sql`delete from content_entities where campaign_id = ${campaignId}::uuid`,
  );
  await connection.close();
});

describe.skipIf(connection === undefined)('EntityDirectory (PostgreSQL)', () => {
  test('player A: gm_only and missing identical, notes never returned, list counts permitted', async () => {
    const db = (connection as NonNullable<typeof connection>).db;
    const entities = new PostgresEntityRepository(db);
    const gm = crypto.randomUUID();
    const playerA = crypto.randomUUID();
    const roles = new Map<string, Role>([
      [gm, 'gm'],
      [playerA, 'player'],
    ]);
    const registry = new ResourcePolicyRegistry();
    for (const policy of [
      CAMPAIGN_ENTITY_POLICY,
      PERSONAL_NOTE_POLICY,
      ENTITY_RELATIONSHIP_POLICY,
    ]) {
      registry.register(policy);
    }
    const directory = new EntityDirectory({
      entities,
      decider: new AuthorizationService(registry),
      actors: {
        resolve: async (userId, campaign) => {
          const role = campaign === campaignId ? roles.get(userId) : undefined;
          return role === undefined
            ? err('membership_not_found')
            : ok({ userId, campaignId, role });
        },
      },
    });
    const insert = async (type: string, name: string, visibility: Visibility) => {
      const id = crypto.randomUUID();
      const created = await entities.insert(db, {
        id,
        campaignId,
        type,
        name,
        summary: `${name} summary`,
        description: 'never in a summary',
        tags: ['probe'],
        fields: {},
        metadata: {},
        visibility,
        actorUserId: gm,
      });
      expect(created.ok).toBe(true);
      return id;
    };
    const smuggler = await insert('npc', 'Smuggler', { mode: 'gm_only' });
    const merchant = await insert('npc', 'Merchant', { mode: 'everyone' });
    const scene = await insert('scene', 'Ambush at the ford', { mode: 'everyone' });
    const missing = crypto.randomUUID();
    // A personal note with the same campaign: another table, never a directory result.
    const noteId = crypto.randomUUID();
    await db.execute(sql`
      insert into content_personal_notes (id, campaign_id, author_user_id, name, body, tags,
        metadata, visibility_mode, visibility_targets, version, created_by, updated_by)
      values (${noteId}::uuid, ${campaignId}::uuid, ${playerA}::uuid, 'My note', '', '[]'::jsonb,
        '{}'::jsonb, 'players', ${JSON.stringify([playerA])}::jsonb, 1, ${playerA}::uuid,
        ${playerA}::uuid)`);

    const hidden = await directory.resolve({ userId: playerA }, campaignId, [smuggler]);
    const absent = await directory.resolve({ userId: playerA }, campaignId, [missing]);
    expect(hidden.size).toBe(0);
    expect([...hidden]).toEqual([...absent]);
    expect((await directory.resolve({ userId: playerA }, campaignId, [noteId])).size).toBe(0);
    expect((await directory.resolve({ userId: gm }, campaignId, [noteId])).size).toBe(0);

    const player = await directory.resolve({ userId: playerA }, campaignId, [
      smuggler,
      merchant,
      scene,
      missing,
      noteId,
    ]);
    expect([...player.keys()].sort()).toEqual([merchant, scene].sort());
    expect(JSON.stringify([...player])).not.toContain('never in a summary');

    const gmList = await directory.list({ userId: gm }, campaignId);
    expect(gmList.total).toBe(3);
    expect(gmList.items.map((item) => item.id)).not.toContain(noteId);
    const playerList = await directory.list({ userId: playerA }, campaignId, { type: 'npc' });
    expect(playerList).toEqual({
      items: [
        {
          id: merchant,
          type: 'npc',
          name: 'Merchant',
          summary: 'Merchant summary',
          visibility: { mode: 'everyone' },
          deleted: false,
        },
      ],
      total: 1,
    });
    expect(await directory.list({ userId: crypto.randomUUID() }, campaignId)).toEqual({
      items: [],
      total: 0,
    });
  });
});
