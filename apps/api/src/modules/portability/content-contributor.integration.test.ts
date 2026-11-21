import { afterAll, describe, expect, test } from 'bun:test';
import { canonicalBytes, ExportRegistry, sha256Hex } from '@rpg/campaign-portability';
import { exportContributorProblems } from '@rpg/campaign-portability/testing';
import {
  type ContentChunk,
  ContentExporter,
  ContentSearchIndexer,
  countContentRecords,
} from '@rpg/content';
import {
  connectContentDatabase,
  PostgresEntityRepository,
  PostgresPersonalNoteRepository,
  PostgresRelationshipRepository,
} from '@rpg/content/postgres';
import { check, SearchDoc, type Visibility } from '@rpg/contracts';
import { FIXTURE_ENTITIES, ITEMS, LOCATIONS, NPCS, USERS } from '@rpg/fixtures';
import postgres from 'postgres';

/**
 * Feature 16 task 15 on PostgreSQL: the content export contributor and search indexer over the
 * sandbox fixture campaign (`PRD.md` s.82: five locations, six NPCs, five items at mixed
 * Visibility), with links, tombstones, and a player's personal note. BDD "Export carries entities
 * with their visibility", "Personal notes are not exported", "Search documents carry visibility".
 * Rows are written through the feature 16 repositories and deleted afterwards.
 */

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const sql =
  databaseUrl === undefined
    ? undefined
    : postgres(databaseUrl, { max: 2, onnotice: () => undefined });
const available = await (async () => {
  if (sql === undefined) return false;
  try {
    await sql`select 1 from content_entities, content_entity_relationships limit 1`;
    return true;
  } catch {
    return false;
  }
})();
const db = sql as NonNullable<typeof sql>;
const connection =
  available && databaseUrl !== undefined ? connectContentDatabase(databaseUrl) : undefined;
const campaigns: string[] = [];

afterAll(async () => {
  if (available && campaigns.length > 0) {
    await db`delete from content_entity_relationships where campaign_id = any(${campaigns}::uuid[])`;
    await db`delete from content_entities where campaign_id = any(${campaigns}::uuid[])`;
    await db`delete from content_personal_notes where campaign_id = any(${campaigns}::uuid[])`;
  }
  await connection?.close();
  await sql?.end({ timeout: 1 });
});

const NOTE_BODY = 'The elder lied about the road';

/** The sandbox campaign under a fresh id, with fresh entity ids (fixture id -> new id). */
async function seedSandbox() {
  if (connection === undefined) throw new Error('database unavailable');
  const campaignId = crypto.randomUUID();
  campaigns.push(campaignId);
  const entities = new PostgresEntityRepository(connection.db);
  const relationships = new PostgresRelationshipRepository(connection.db);
  const notes = new PostgresPersonalNoteRepository(connection.db);
  const ids = new Map(FIXTURE_ENTITIES.map((entity) => [entity.id, crypto.randomUUID()]));
  const id = (fixtureId: string) => ids.get(fixtureId) as string;
  for (const entity of FIXTURE_ENTITIES) {
    const inserted = await entities.insert(connection.db, {
      id: id(entity.id),
      campaignId,
      type: entity.type,
      name: entity.name,
      summary: `About ${entity.name}`,
      description: `# ${entity.name}\nMarkdown source`,
      tags: entity.tags,
      fields: entity.type === 'npc' ? { Price: 'one silver', Email: 'in-world letter' } : {},
      metadata: {},
      visibility: entity.visibility,
      actorUserId: USERS.gm,
    });
    if (!inserted.ok) throw new Error('seed failed');
  }
  const link = async (source: string, target: string, kind: string, visibility: Visibility) => {
    const inserted = await relationships.insert(connection.db, {
      id: crypto.randomUUID(),
      campaignId,
      sourceEntityId: id(source),
      targetEntityId: id(target),
      kind,
      visibility,
      actorUserId: USERS.gm,
    });
    if (!inserted.ok) throw new Error('link failed');
    return inserted.record;
  };
  const tombstone = async (fixtureId: string) => {
    const deleted = await entities.tombstone(connection.db, {
      campaignId,
      id: id(fixtureId),
      expectedVersion: 1,
      actorUserId: USERS.gm,
    });
    if (!deleted.ok) throw new Error('tombstone failed');
  };
  await link(NPCS.merchant, LOCATIONS.village, 'lives_at', { mode: 'everyone' });
  await link(NPCS.smuggler, LOCATIONS.abandonedWarehouse, 'knows', { mode: 'gm_only' });
  // Supply Crate is deleted but a live link still references it: kept, flagged deleted.
  await link(ITEMS.supplyCrate, LOCATIONS.tradingPost, 'located_at', { mode: 'gm_only' });
  // Broken Seal is deleted and only a deleted link references it: absent.
  const dropped = await link(ITEMS.brokenSeal, NPCS.smuggler, 'owns', { mode: 'gm_only' });
  const unlinked = await relationships.tombstone(connection.db, {
    campaignId,
    id: dropped.id,
    expectedVersion: 1,
    actorUserId: USERS.gm,
  });
  if (!unlinked.ok) throw new Error('unlink failed');
  await tombstone(ITEMS.supplyCrate);
  await tombstone(ITEMS.brokenSeal);
  const note = await notes.insert(connection.db, {
    id: crypto.randomUUID(),
    campaignId,
    authorUserId: USERS.playerA,
    name: 'Suspicions',
    body: NOTE_BODY,
    tags: [],
    metadata: {},
  });
  if (!note.ok) throw new Error('note failed');
  return { campaignId, entities, relationships, id };
}

describe.skipIf(!available)('content export and search contributors (PostgreSQL)', () => {
  test('export: live rows per type, referenced tombstones only, Visibility as stored, kit clean, deterministic', async () => {
    const { campaignId, entities, relationships, id } = await seedSandbox();
    const exporter = new ContentExporter({ entities, relationships });
    const registry = new ExportRegistry().register(exporter, {
      placement: 'entities',
      countRecords: countContentRecords,
    });
    const registration = registry.get('content');
    if (registration === undefined) throw new Error('not registered');

    const first = await exporter.export(campaignId);
    expect([first.moduleId, first.chunkVersion]).toEqual(['content', '1']);
    const chunk = first.payload as ContentChunk;

    // Per-type live counts equal the live rows; relationship count equals the live links.
    const liveByType = await db`select type, count(*)::int as n from content_entities
      where campaign_id = ${campaignId} and deleted_at is null group by type order by type`;
    const exportedByType = new Map<string, number>();
    for (const entity of chunk.entities.filter((row) => !row.deleted)) {
      exportedByType.set(entity.type, (exportedByType.get(entity.type) ?? 0) + 1);
    }
    expect(Object.fromEntries(exportedByType)).toEqual(
      Object.fromEntries(liveByType.map((row) => [row.type, row.n])),
    );
    expect(Object.fromEntries(exportedByType)).toEqual({ location: 5, npc: 6, item: 3 });
    const [links] = await db`select count(*)::int as n from content_entity_relationships
      where campaign_id = ${campaignId} and deleted_at is null`;
    expect(chunk.relationships).toHaveLength(links?.n ?? -1);
    expect(chunk.relationships).toHaveLength(3);

    // Only the tombstone a live relationship references is present, flagged deleted.
    const deleted = chunk.entities.filter((row) => row.deleted);
    expect(deleted.map((row) => row.id)).toEqual([id(ITEMS.supplyCrate)]);
    expect(deleted[0]?.deletedAt).toBeString();
    expect(chunk.entities.some((row) => row.id === id(ITEMS.brokenSeal))).toBe(false);

    // Every Visibility equals the stored one; nothing names an actor.
    for (const entity of chunk.entities) {
      const stored = await entities.get(campaignId, entity.id, { includeDeleted: true });
      expect(entity.visibility).toEqual(stored?.visibility as Visibility);
    }
    for (const link of chunk.relationships) {
      expect(link.visibility).toEqual(
        (await relationships.get(campaignId, link.id))?.visibility as Visibility,
      );
    }
    const letter = chunk.entities.find((row) => row.id === id(ITEMS.weatheredLetter));
    expect(letter?.visibility).toEqual({ mode: 'players', playerIds: [USERS.playerA] });
    expect(chunk.entities.map((row) => row.id)).toEqual(
      [...chunk.entities.map((row) => row.id)].sort(),
    );
    // Free-form labels travel as values (never keys), sorted by label.
    const merchant = chunk.entities.find((row) => row.id === id(NPCS.merchant));
    expect(merchant?.fields).toEqual([
      { label: 'Email', value: 'in-world letter' },
      { label: 'Price', value: 'one silver' },
    ]);

    // Conformance kit: schema, version, determinism, forbidden-data scan, record count.
    expect(
      await exportContributorProblems(registration, campaignId, {
        expectedRecords: chunk.entities.length + chunk.relationships.length,
      }),
    ).toEqual([]);
    // Two consecutive exports with no write between them: equal canonical checksums.
    const second = await exporter.export(campaignId);
    expect(await sha256Hex(canonicalBytes(second.payload))).toBe(
      await sha256Hex(canonicalBytes(first.payload)),
    );

    // Personal notes are absent (D-12).
    const text = JSON.stringify(first);
    expect(text).not.toContain(NOTE_BODY);
    expect(text).not.toContain('Suspicions');
    expect(text).not.toContain(USERS.gm);
    // Frozen import stays unsupported (import is task 17's transaction-aware surface).
    expect(await exporter.import(campaignId, first)).toEqual({
      ok: false,
      error: 'content_import_unsupported',
    });
  });

  test('search: one valid SearchDoc per live entity with the row Visibility; no notes or links', async () => {
    const { campaignId, entities, id } = await seedSandbox();
    const docs = await new ContentSearchIndexer({ entities }).index(campaignId);
    const live = await entities.list(campaignId);
    expect(docs.map((doc) => doc.id)).toEqual(live.map((row) => row.id).sort());
    expect(docs).toHaveLength(14);
    for (const doc of docs) {
      expect(check(SearchDoc, doc)).toBe(true);
      const stored = live.find((row) => row.id === doc.id);
      expect(doc).toEqual({
        id: stored?.id as string,
        type: stored?.type as string,
        title: stored?.name as string,
        body: `${stored?.summary}\n\n${stored?.description}`,
        campaignId,
        visibility: stored?.visibility as Visibility,
      });
    }
    // BDD "Search documents carry visibility": revealed to player A only.
    expect(docs.find((doc) => doc.id === id(ITEMS.weatheredLetter))?.visibility).toEqual({
      mode: 'players',
      playerIds: [USERS.playerA],
    });
    expect(docs.some((doc) => doc.id === id(ITEMS.supplyCrate))).toBe(false);
    expect(JSON.stringify(docs)).not.toContain(NOTE_BODY);
    expect(new Set(docs.map((doc) => doc.type))).toEqual(new Set(['location', 'npc', 'item']));
  });
});
