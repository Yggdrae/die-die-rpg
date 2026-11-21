import { afterAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import {
  connectContentDatabase,
  type NewEntity,
  PostgresEntityRepository,
  PostgresPersonalNoteRepository,
} from './repository.ts';

/**
 * Feature 16 task 02 against PostgreSQL (`_db.md` "Required Data Tests"): CHECKs, compare-and-set,
 * tombstones, list filters. Rows use random campaign ids and are deleted afterwards. Skipped when
 * no database with the 0011 migration is reachable.
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

const campaigns: string[] = [];
function campaign(): string {
  const id = crypto.randomUUID();
  campaigns.push(id);
  return id;
}

afterAll(async () => {
  if (connection === undefined) return;
  const ids = sql.join(
    campaigns.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  await connection.db.execute(sql`delete from content_entities where campaign_id in (${ids})`);
  await connection.db.execute(
    sql`delete from content_personal_notes where campaign_id in (${ids})`,
  );
  const [left] = (await connection.db.execute(
    sql`select (select count(*) from content_entities where campaign_id in (${ids}))
      + (select count(*) from content_personal_notes where campaign_id in (${ids})) as n`,
  )) as unknown as { n: string | number }[];
  expect(Number(left?.n)).toBe(0);
  await connection.close();
});

function constraintOf(error: unknown): string | undefined {
  let current: unknown = error;
  while (typeof current === 'object' && current !== null) {
    if ('constraint_name' in current && typeof current.constraint_name === 'string') {
      return current.constraint_name;
    }
    current = 'cause' in current ? current.cause : undefined;
  }
  return undefined;
}

const actor = '00000000-0000-4000-8000-0000000000aa';
const player = '00000000-0000-4000-8000-0000000000b1';
const otherPlayer = '00000000-0000-4000-8000-0000000000b2';

function entity(campaignId: string, overrides: Partial<NewEntity> = {}): NewEntity {
  return {
    id: crypto.randomUUID(),
    campaignId,
    type: 'npc',
    name: 'Ferryman',
    summary: 'Asks for silver, takes copper',
    description: '',
    tags: [],
    fields: {},
    metadata: {},
    visibility: { mode: 'gm_only' },
    actorUserId: actor,
    ...overrides,
  };
}

describe.skipIf(connection === undefined)('content tables on PostgreSQL', () => {
  const db = () => {
    if (connection === undefined) throw new Error('database unavailable');
    return connection.db;
  };
  const entities = () => new PostgresEntityRepository(db());
  const notes = () => new PostgresPersonalNoteRepository(db());

  /** Inserts one raw entity row with `column = value` overridden; returns the violated CHECK. */
  async function rawEntity(overrides: Record<string, string>): Promise<string | undefined> {
    const values: Record<string, string> = {
      id: `'${crypto.randomUUID()}'`,
      campaign_id: `'${campaign()}'`,
      type: `'npc'`,
      name: `'Ferryman'`,
      visibility_mode: `'gm_only'`,
      visibility_targets: `'[]'::jsonb`,
      created_by: `'${actor}'`,
      updated_by: `'${actor}'`,
      ...overrides,
    };
    try {
      await db().execute(
        sql.raw(
          `insert into content_entities (${Object.keys(values).join(', ')})
           values (${Object.values(values).join(', ')})`,
        ),
      );
      return undefined;
    } catch (error) {
      return constraintOf(error) ?? 'error';
    }
  }

  async function rawNote(overrides: Record<string, string>): Promise<string | undefined> {
    const values: Record<string, string> = {
      id: `'${crypto.randomUUID()}'`,
      campaign_id: `'${campaign()}'`,
      author_user_id: `'${player}'`,
      name: `'Elder lied'`,
      visibility_mode: `'players'`,
      visibility_targets: `'["${player}"]'::jsonb`,
      created_by: `'${player}'`,
      updated_by: `'${player}'`,
      ...overrides,
    };
    try {
      await db().execute(
        sql.raw(
          `insert into content_personal_notes (${Object.keys(values).join(', ')})
           values (${Object.values(values).join(', ')})`,
        ),
      );
      return undefined;
    } catch (error) {
      return constraintOf(error) ?? 'error';
    }
  }

  test('CHECKs reject every invalid representation on content_entities', async () => {
    const [a, b] = [player, otherPlayer];
    const cases: [Record<string, string>, string][] = [
      [{ visibility_mode: `'secret'` }, 'content_entities_visibility_mode_check'],
      [{ visibility_targets: `'["${a}"]'::jsonb` }, 'content_entities_visibility_targets_check'],
      [
        { visibility_mode: `'everyone'`, visibility_targets: `'["${a}"]'::jsonb` },
        'content_entities_visibility_targets_check',
      ],
      [{ visibility_mode: `'players'` }, 'content_entities_visibility_targets_check'],
      [
        { visibility_mode: `'players'`, visibility_targets: `'["${b}", "${a}"]'::jsonb` },
        'content_entities_visibility_targets_check',
      ],
      [
        { visibility_mode: `'players'`, visibility_targets: `'["${a}", "${a}"]'::jsonb` },
        'content_entities_visibility_targets_check',
      ],
      [
        {
          visibility_mode: `'players'`,
          visibility_targets: `'["${a.toUpperCase()}"]'::jsonb`,
        },
        'content_entities_visibility_targets_check',
      ],
      [
        { visibility_mode: `'players'`, visibility_targets: `'"${a}"'::jsonb` },
        'content_entities_visibility_targets_check',
      ],
      [{ type: `'Villain'` }, 'content_entities_type_check'],
      [{ type: `'npc-x'` }, 'content_entities_type_check'],
      [{ name: `''` }, 'content_entities_name_check'],
      [{ name: `'   '` }, 'content_entities_name_check'],
      [{ name: `' Ferryman'` }, 'content_entities_name_check'],
      [{ name: `repeat('n', 201)` }, 'content_entities_name_check'],
      [{ summary: `repeat('s', 281)` }, 'content_entities_summary_check'],
      [{ description: `repeat('d', 50001)` }, 'content_entities_description_check'],
      [{ tags: `'{"a": 1}'::jsonb` }, 'content_entities_tags_check'],
      [{ tags: `'"village"'::jsonb` }, 'content_entities_tags_check'],
      [
        {
          tags: `(select jsonb_agg('t' || g) from generate_series(1, 33) g)`,
        },
        'content_entities_tags_check',
      ],
      [{ fields: `'[]'::jsonb` }, 'content_entities_fields_check'],
      [{ metadata: `'[]'::jsonb` }, 'content_entities_metadata_check'],
      [{ version: '0' }, 'content_entities_version_check'],
    ];
    for (const [overrides, constraint] of cases) {
      expect({ overrides, violated: await rawEntity(overrides) }).toEqual({
        overrides,
        violated: constraint,
      });
    }
    // Boundaries are accepted.
    const accepted: Record<string, string>[] = [
      { name: `repeat('n', 200)` },
      { summary: `repeat('s', 280)`, description: `repeat('d', 50000)` },
      { tags: `(select jsonb_agg('t' || g) from generate_series(1, 32) g)` },
      { visibility_mode: `'players'`, visibility_targets: `'["${a}", "${b}"]'::jsonb` },
      { visibility_mode: `'everyone'`, type: `'vehicle'` },
    ];
    for (const overrides of accepted) {
      expect({ overrides, violated: await rawEntity(overrides) }).toEqual({
        overrides,
        violated: undefined,
      });
    }
  });

  test('CHECKs reject invalid personal notes, including any Visibility but players:[author]', async () => {
    const cases: [Record<string, string>, string][] = [
      [
        { visibility_mode: `'gm_only'`, visibility_targets: `'[]'::jsonb` },
        'content_personal_notes_visibility_check',
      ],
      [
        { visibility_mode: `'everyone'`, visibility_targets: `'[]'::jsonb` },
        'content_personal_notes_visibility_check',
      ],
      [
        { visibility_targets: `'["${otherPlayer}"]'::jsonb` },
        'content_personal_notes_visibility_check',
      ],
      [
        { visibility_targets: `'["${player}", "${otherPlayer}"]'::jsonb` },
        'content_personal_notes_visibility_check',
      ],
      [{ created_by: `'${otherPlayer}'` }, 'content_personal_notes_author_check'],
      [{ name: `'  '` }, 'content_personal_notes_name_check'],
      [{ name: `repeat('n', 201)` }, 'content_personal_notes_name_check'],
      [{ body: `repeat('b', 50001)` }, 'content_personal_notes_body_check'],
      [{ tags: `'{}'::jsonb` }, 'content_personal_notes_tags_check'],
      [{ version: '0' }, 'content_personal_notes_version_check'],
    ];
    for (const [overrides, constraint] of cases) {
      expect({ overrides, violated: await rawNote(overrides) }).toEqual({
        overrides,
        violated: constraint,
      });
    }
    expect(await rawNote({ body: `repeat('b', 50000)` })).toBeUndefined();
  });

  test('insert stores the record; an existing id is never overwritten', async () => {
    const campaignId = campaign();
    const input = entity(campaignId, {
      tags: ['antagonist', 'village'],
      fields: { Price: 'one silver' },
    });
    const created = await entities().insert(db(), input);
    if (!created.ok) throw new Error('insert failed');
    expect(created.record).toMatchObject({
      id: input.id,
      campaignId,
      type: 'npc',
      name: 'Ferryman',
      summary: 'Asks for silver, takes copper',
      tags: ['antagonist', 'village'],
      fields: { Price: 'one silver' },
      visibility: { mode: 'gm_only' },
      version: 1,
      createdBy: actor,
      updatedBy: actor,
    });
    expect(created.record.deletedAt).toBeUndefined();
    expect(created.record.createdAt).toMatch(/Z$/);
    const again = await entities().insert(db(), { ...input, name: 'Imposter' });
    expect(again).toEqual({ ok: false, reason: 'exists' });
    expect((await entities().get(campaignId, input.id))?.name).toBe('Ferryman');
    // Another campaign cannot load it.
    expect(await entities().get(campaign(), input.id)).toBeUndefined();
  });

  test('compare-and-set: a stale version changes nothing and reports the actual version', async () => {
    const campaignId = campaign();
    const input = entity(campaignId);
    await entities().insert(db(), input);
    const renamed = await entities().update(db(), {
      campaignId,
      id: input.id,
      expectedVersion: 1,
      actorUserId: player,
      changes: { name: 'Boatman', tags: ['ferry'] },
    });
    expect(renamed.ok && renamed.record).toMatchObject({
      name: 'Boatman',
      tags: ['ferry'],
      version: 2,
      updatedBy: player,
      summary: 'Asks for silver, takes copper',
    });
    const stale = await entities().update(db(), {
      campaignId,
      id: input.id,
      expectedVersion: 1,
      actorUserId: actor,
      changes: { name: 'Stale' },
    });
    expect(stale.ok).toBe(false);
    if (stale.ok || stale.reason !== 'version_conflict') throw new Error('expected conflict');
    expect(stale.current.version).toBe(2);
    expect(stale.current.name).toBe('Boatman');
    expect(
      await entities().update(db(), {
        campaignId: campaign(),
        id: input.id,
        expectedVersion: 2,
        actorUserId: actor,
        changes: { name: 'Elsewhere' },
      }),
    ).toEqual({ ok: false, reason: 'not_found' });
  });

  test('two concurrent writes at the same version produce one winner', async () => {
    for (let round = 0; round < 5; round += 1) {
      const campaignId = campaign();
      const input = entity(campaignId);
      await entities().insert(db(), input);
      const results = await Promise.all(
        ['Avery edit', 'Blake edit'].map((name) =>
          entities().transaction((tx) =>
            entities().update(tx, {
              campaignId,
              id: input.id,
              expectedVersion: 1,
              actorUserId: actor,
              changes: { name },
            }),
          ),
        ),
      );
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(
        results.filter((result) => !result.ok && result.reason === 'version_conflict'),
      ).toHaveLength(1);
      expect((await entities().get(campaignId, input.id))?.version).toBe(2);
    }
  });

  test('Delete is a soft delete: tombstone sets deleted_at and increments the version', async () => {
    const campaignId = campaign();
    const input = entity(campaignId);
    await entities().insert(db(), input);
    await entities().update(db(), {
      campaignId,
      id: input.id,
      expectedVersion: 1,
      actorUserId: actor,
      changes: { summary: 'v2' },
    });
    const deleted = await entities().tombstone(db(), {
      campaignId,
      id: input.id,
      expectedVersion: 2,
      actorUserId: actor,
    });
    expect(deleted.ok && deleted.record.version).toBe(3);
    expect(deleted.ok && typeof deleted.record.deletedAt).toBe('string');
    expect(await entities().get(campaignId, input.id)).toBeUndefined();
    expect((await entities().get(campaignId, input.id, { includeDeleted: true }))?.version).toBe(3);
    expect((await entities().list(campaignId)).map((item) => item.id)).toEqual([]);
    expect((await entities().list(campaignId, { includeDeleted: true })).length).toBe(1);
    // A deleted entity cannot be edited or deleted again.
    const edit = await entities().update(db(), {
      campaignId,
      id: input.id,
      expectedVersion: 3,
      actorUserId: actor,
      changes: { name: 'Ghost' },
    });
    expect(edit.ok ? 'ok' : edit.reason).toBe('deleted');
    const record = await entities().get(campaignId, input.id, { includeDeleted: true });
    expect([record?.name, record?.version]).toEqual(['Ferryman', 3]);
  });

  test('list filters by type, tag, visibility, and name fragment', async () => {
    const campaignId = campaign();
    const rows = [
      entity(campaignId, { name: 'Bandit Leader', tags: ['antagonist'] }),
      entity(campaignId, { name: 'Elder', visibility: { mode: 'everyone' } }),
      entity(campaignId, { type: 'location', name: 'Old 100%_Road', tags: ['site'] }),
      entity(campaignId, {
        type: 'location',
        name: 'Warehouse',
        tags: ['antagonist', 'site'],
        visibility: { mode: 'players', playerIds: [player] },
      }),
    ];
    for (const row of rows) await entities().insert(db(), row);
    await entities().insert(db(), entity(campaign(), { name: 'Bandit elsewhere' }));
    const names = async (filter: Parameters<PostgresEntityRepository['list']>[1]) =>
      (await entities().list(campaignId, filter)).map((item) => item.name).sort();
    expect(await names({ type: 'npc' })).toEqual(['Bandit Leader', 'Elder']);
    expect(await names({ tag: 'antagonist' })).toEqual(['Bandit Leader', 'Warehouse']);
    expect(await names({ visibilityModes: ['gm_only'] })).toEqual([
      'Bandit Leader',
      'Old 100%_Road',
    ]);
    expect(await names({ visibilityModes: [] })).toEqual([]);
    expect(await names({ type: 'location', tag: 'site' })).toEqual(['Old 100%_Road', 'Warehouse']);
    expect(await names({ nameFragment: 'bandit' })).toEqual(['Bandit Leader']);
    // LIKE metacharacters match literally.
    expect(await names({ nameFragment: '%_' })).toEqual(['Old 100%_Road']);
    expect(await names({ nameFragment: '_' })).toEqual(['Old 100%_Road']);
    expect((await entities().list(campaignId)).length).toBe(4);
  });

  test('personal notes: fixed players:[author] Visibility, CAS, tombstone, author listing', async () => {
    const campaignId = campaign();
    const id = crypto.randomUUID();
    const created = await notes().insert(db(), {
      id,
      campaignId,
      authorUserId: player,
      name: 'Elder lied about the road',
      body: '',
      tags: [],
      metadata: {},
    });
    expect(created.ok && created.record).toMatchObject({
      type: 'note',
      authorUserId: player,
      visibility: { mode: 'players', playerIds: [player] },
      version: 1,
      createdBy: player,
    });
    await notes().insert(db(), {
      id: crypto.randomUUID(),
      campaignId,
      authorUserId: otherPlayer,
      name: 'Rowan note',
      body: '',
      tags: [],
      metadata: {},
    });
    expect((await notes().listByAuthor(campaignId, player)).map((note) => note.id)).toEqual([id]);
    const edited = await notes().update(db(), {
      campaignId,
      id,
      expectedVersion: 1,
      actorUserId: player,
      changes: { body: 'The road is flooded.' },
    });
    expect(edited.ok && [edited.record.body, edited.record.version]).toEqual([
      'The road is flooded.',
      2,
    ]);
    const stale = await notes().update(db(), {
      campaignId,
      id,
      expectedVersion: 1,
      actorUserId: player,
      changes: { body: 'stale' },
    });
    expect(stale.ok ? 'ok' : stale.reason).toBe('version_conflict');
    const deleted = await notes().tombstone(db(), {
      campaignId,
      id,
      expectedVersion: 2,
      actorUserId: player,
    });
    expect(deleted.ok && deleted.record.version).toBe(3);
    expect(await notes().get(campaignId, id)).toBeUndefined();
    expect((await notes().get(campaignId, id, { includeDeleted: true }))?.deletedAt).toBeString();
    expect(await notes().listByAuthor(campaignId, player)).toEqual([]);
  });
});
