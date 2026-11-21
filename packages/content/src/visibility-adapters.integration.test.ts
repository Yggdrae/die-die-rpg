import { afterAll, describe, expect, test } from 'bun:test';
import { runVisibilityAdapterContract } from '@rpg/authorization';
import { sql } from 'drizzle-orm';
import {
  connectContentDatabase,
  PostgresEntityRepository,
  PostgresPersonalNoteRepository,
} from './infra/postgres/repository.ts';
import { EntityVisibilityAdapter, personalNoteFactsSource } from './visibility-adapters.ts';

/**
 * Feature 16 task 03 on PostgreSQL: the `campaign_entity` adapter passes the shared feature 04
 * contract (all 10 checks, `tombstone_excluded` included), and the personal-note facts source
 * carries the author and hides tombstones. Rows are deleted afterwards.
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

const campaigns = new Set<string>();
const ACTOR = '00000000-0000-4000-8000-0000000000aa';

afterAll(async () => {
  if (connection === undefined) return;
  const ids = [...campaigns];
  if (ids.length > 0) {
    const list = sql.join(
      ids.map((id) => sql`${id}::uuid`),
      sql`, `,
    );
    await connection.db.execute(sql`delete from content_entities where campaign_id in (${list})`);
    await connection.db.execute(
      sql`delete from content_personal_notes where campaign_id in (${list})`,
    );
  }
  await connection.close();
});

describe.skipIf(connection === undefined)('campaign_entity Visibility adapter (PostgreSQL)', () => {
  test('runVisibilityAdapterContract: no findings, tombstone supplied (10 checks)', async () => {
    if (connection === undefined) throw new Error('database unavailable');
    const entities = new PostgresEntityRepository(connection.db);
    const report = await runVisibilityAdapterContract({
      adapter: new EntityVisibilityAdapter(entities),
      seed: async ({ campaignId, visibility }) => {
        campaigns.add(campaignId);
        const id = crypto.randomUUID();
        const created = await entities.insert(connection.db, {
          id,
          campaignId,
          type: 'npc',
          name: 'Contract probe',
          summary: '',
          description: '',
          tags: [],
          fields: {},
          metadata: {},
          visibility,
          actorUserId: ACTOR,
        });
        if (!created.ok) throw new Error('seed failed');
        return id;
      },
      tombstone: async (campaignId, resourceId) => {
        const current = await entities.get(campaignId, resourceId);
        if (current === undefined) throw new Error('tombstone target missing');
        const deleted = await entities.tombstone(connection.db, {
          campaignId,
          id: resourceId,
          expectedVersion: current.version,
          actorUserId: ACTOR,
        });
        if (!deleted.ok) throw new Error('tombstone failed');
      },
    });
    expect(report.resourceClass).toBe('campaign_entity');
    expect(report.checks).toHaveLength(10);
    expect(report.checks).toContain('tombstone_excluded');
    expect(report.findings).toEqual([]);
  });

  test('a malformed identifier has no facts and cannot be written', async () => {
    if (connection === undefined) throw new Error('database unavailable');
    const adapter = new EntityVisibilityAdapter(new PostgresEntityRepository(connection.db));
    const campaignId = crypto.randomUUID();
    expect(await adapter.loadFacts(campaignId, 'not-a-uuid')).toBeUndefined();
    let audited = 0;
    expect(
      await adapter.writeVisibility({
        campaignId,
        resourceId: 'not-a-uuid',
        expectedVersion: 1,
        visibility: { mode: 'everyone' },
        recordAudit: async () => {
          audited += 1;
        },
      }),
    ).toEqual({ ok: false, reason: 'not_found' });
    expect(audited).toBe(0);
  });
});

describe.skipIf(connection === undefined)('personal_note facts source (PostgreSQL)', () => {
  test('facts carry the author; missing, foreign, and tombstoned notes have none', async () => {
    if (connection === undefined) throw new Error('database unavailable');
    const notes = new PostgresPersonalNoteRepository(connection.db);
    const source = personalNoteFactsSource(notes);
    const campaignId = crypto.randomUUID();
    campaigns.add(campaignId);
    const author = crypto.randomUUID();
    const id = crypto.randomUUID();
    await notes.insert(connection.db, {
      id,
      campaignId,
      authorUserId: author,
      name: 'Elder lied about the road',
      body: '',
      tags: [],
      metadata: {},
    });
    expect(source.resourceClass).toBe('personal_note');
    expect(await source.loadFacts(campaignId, id)).toEqual({
      campaignId,
      resourceClass: 'personal_note',
      resourceId: id,
      visibility: { mode: 'players', playerIds: [author] },
      version: 1,
      authorUserId: author,
    });
    expect(await source.loadFacts(crypto.randomUUID(), id)).toBeUndefined();
    expect(await source.loadFacts(campaignId, crypto.randomUUID())).toBeUndefined();
    await notes.tombstone(connection.db, {
      campaignId,
      id,
      expectedVersion: 1,
      actorUserId: author,
    });
    expect(await source.loadFacts(campaignId, id)).toBeUndefined();
  });
});
