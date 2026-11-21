import { describe, expect, test } from 'bun:test';
import {
  type EntityEnvelope,
  err,
  ok,
  type RepositoryError,
  type Result,
  type SyncedRepository,
} from '@rpg/contracts';
import {
  EntityLocalRepository,
  PersonalNoteLocalRepository,
  RelationshipLocalRepository,
} from './offline.ts';
import type { EntityRecord, PersonalNoteRecord, RelationshipRecord } from './schemas.ts';

/**
 * Device repositories (tasks 06 and 09) over an in-memory `SyncedRepository`: the pure rules run
 * before anything is queued, the hold version travels only in the queued payload, and links are
 * pre-validated against the locally visible endpoints with the relationship bound. The real
 * SQLite queue round trip to the authority is in the API applier integration test.
 */

const CAMPAIGN = '00000000-0000-4000-8000-0000000000c1';
const GM = '00000000-0000-4000-8000-0000000000a1';

class MemoryRepository<T extends EntityEnvelope> implements SyncedRepository<T> {
  readonly rows = new Map<string, T>();
  readonly queued: { value: T; expectedVersion: number | null }[] = [];
  readonly conflicts = { subscribe: () => () => undefined };

  async get(id: string): Promise<Result<T, RepositoryError>> {
    const row = this.rows.get(id);
    return row === undefined ? err({ kind: 'not_found', id }) : ok(row);
  }

  async list(campaignId: string): Promise<Result<T[], RepositoryError>> {
    return ok([...this.rows.values()].filter((row) => row.campaignId === campaignId));
  }

  async upsert(value: T, expectedVersion: number | null): Promise<Result<T, RepositoryError>> {
    const current = this.rows.get(value.id);
    if ((current?.version ?? null) !== expectedVersion) {
      return err({
        kind: 'version_conflict',
        id: value.id,
        expectedVersion: expectedVersion ?? 0,
        actualVersion: current?.version ?? 0,
      });
    }
    const stored = { ...value, version: (current?.version ?? 0) + 1 };
    this.rows.set(value.id, stored);
    this.queued.push({ value: stored, expectedVersion });
    return ok(stored);
  }

  async softDelete(id: string, expectedVersion: number): Promise<Result<void, RepositoryError>> {
    const current = this.rows.get(id);
    if (current === undefined) return err({ kind: 'not_found', id });
    this.rows.set(id, {
      ...current,
      version: current.version + 1,
      deletedAt: '2026-10-28T12:00:00.000Z',
    });
    this.queued.push({ value: current, expectedVersion });
    return ok(undefined);
  }
}

function device() {
  const actor = { userId: GM, campaignId: CAMPAIGN };
  const entityRows = new MemoryRepository<EntityRecord>();
  const entities = new EntityLocalRepository(entityRows, actor);
  const relationshipRows = new MemoryRepository<RelationshipRecord>();
  const relationships = new RelationshipLocalRepository(relationshipRows, entities, actor);
  const noteRows = new MemoryRepository<PersonalNoteRecord>();
  const notes = new PersonalNoteLocalRepository(noteRows, actor);
  return { entities, entityRows, relationships, relationshipRows, notes, noteRows };
}

describe('device content repositories', () => {
  test('quick create from a name alone; type from the entry point, else note (D-09)', async () => {
    const d = device();
    const npc = await d.entities.quickCreate({
      type: 'npc',
      name: ' Ferryman ',
      summary: 'Silver',
    });
    expect(npc.ok && npc.value).toMatchObject({
      type: 'npc',
      name: 'Ferryman',
      summary: 'Silver',
      visibility: { mode: 'gm_only' },
      version: 1,
      createdBy: GM,
    });
    const generic = await d.entities.quickCreate({ name: 'Rumor' });
    expect(generic.ok && generic.value.type).toBe('note');
    expect(await d.entities.quickCreate({ name: '   ' })).toEqual(err('name_required'));
    expect(await d.entities.quickCreate({ type: 'villain', name: 'X' })).toEqual(
      err('unknown_type'),
    );
    expect(d.entityRows.queued).toHaveLength(2);
  });

  test('edits are validated and versioned; the hold version rides only in the queued payload', async () => {
    const d = device();
    const created = await d.entities.quickCreate({ type: 'npc', name: 'Bandit' });
    if (!created.ok) throw new Error('create failed');
    const id = created.value.id;
    expect(await d.entities.update(id, { tags: ['t'.repeat(65)] }, 1)).toEqual(err('tag_too_long'));
    const tagged = await d.entities.update(id, { tags: [' Antagonist ', 'antagonist'] }, 1);
    expect(tagged.ok && tagged.value.tags).toEqual(['antagonist']);
    const described = await d.entities.saveDescription(id, 'Leads the river gang.', {
      expectedVersion: 2,
      holdVersion: 7,
    });
    expect(described.ok && described.value).toMatchObject({ description: 'Leads the river gang.' });
    expect(described.ok && 'holdVersion' in described.value).toBe(false);
    expect(d.entityRows.queued.at(-1)?.value).toMatchObject({ holdVersion: 7, version: 3 });
    expect((await d.entities.get(id)) && 'holdVersion' in ((await d.entities.get(id)) ?? {})).toBe(
      false,
    );
    expect((await d.entities.list({ nameFragment: 'band' })).map((row) => row.name)).toEqual([
      'Bandit',
    ]);
    expect((await d.entities.remove(id, 3)).ok).toBe(true);
    expect(await d.entities.get(id)).toBeUndefined();
  });

  test('links are pre-validated against locally visible endpoints (task 09)', async () => {
    const d = device();
    const make = async (name: string, visibility?: EntityRecord['visibility']) => {
      const created = await d.entities.create({
        type: 'npc',
        name,
        ...(visibility ? { visibility } : {}),
      });
      if (!created.ok) throw new Error('create failed');
      return created.value.id;
    };
    const a = await make('A', { mode: 'everyone' });
    const b = await make('B', { mode: 'everyone' });
    const hidden = await make('Hidden');
    const linked = await d.relationships.link({
      sourceEntityId: a,
      targetEntityId: b,
      kind: 'knows',
    });
    expect(linked.ok && linked.value).toMatchObject({
      kind: 'knows',
      name: 'knows',
      visibility: { mode: 'gm_only' },
    });
    expect(
      await d.relationships.link({ sourceEntityId: a, targetEntityId: b, kind: 'knows' }),
    ).toEqual(err('duplicate_relationship'));
    expect(
      await d.relationships.link({ sourceEntityId: a, targetEntityId: a, kind: 'knows' }),
    ).toEqual(err('self_link'));
    expect(
      await d.relationships.link({ sourceEntityId: a, targetEntityId: b, kind: 'hates' }),
    ).toEqual(err('unknown_kind'));
    expect(
      await d.relationships.link({
        sourceEntityId: a,
        targetEntityId: crypto.randomUUID(),
        kind: 'knows',
      }),
    ).toEqual(err('invalid_endpoint'));
    expect(
      await d.relationships.link({
        sourceEntityId: a,
        targetEntityId: hidden,
        kind: 'owns',
        visibility: { mode: 'everyone' },
      }),
    ).toEqual(err('incompatible_visibility'));
    expect(await d.relationships.listFor(b)).toHaveLength(1);
    if (!linked.ok) throw new Error('unreachable');
    expect((await d.relationships.unlink(linked.value.id, 1)).ok).toBe(true);
    expect(await d.relationships.listFor(b)).toEqual([]);
  });

  test("a player's note is authored by the device user with Visibility players:[author]", async () => {
    const d = device();
    const note = await d.notes.create({ name: 'Elder lied', body: 'He did.' });
    expect(note.ok && note.value).toMatchObject({
      authorUserId: GM,
      visibility: { mode: 'players', playerIds: [GM] },
      body: 'He did.',
    });
    expect(await d.notes.create({ name: '' })).toEqual(err('name_required'));
  });
});

describe('feature 17 queued reveal (D-03, D-04)', () => {
  const PLAYER = '00000000-0000-4000-8000-0000000000b1';
  const OTHER = '00000000-0000-4000-8000-0000000000b2';

  function revealDevice() {
    const actor = { userId: GM, campaignId: CAMPAIGN };
    const rows = new MemoryRepository<EntityRecord>();
    const entities = new EntityLocalRepository(rows, actor, { visibilityRecords: rows });
    return { rows, entities };
  }

  test('a reveal shows at once and queues the intent with the previewed version', async () => {
    const d = revealDevice();
    const created = await d.entities.create({
      type: 'handout',
      name: 'Letter',
      description: 'Meet me.',
    });
    if (!created.ok) throw new Error('create failed');
    const revealed = await d.entities.changeVisibility(
      created.value.id,
      { operation: 'reveal', target: { mode: 'players', playerIds: [PLAYER] } },
      created.value.version,
    );
    expect(revealed.ok && revealed.value.visibility).toEqual({
      mode: 'players',
      playerIds: [PLAYER],
    });
    // The stored record never keeps the intent; the queued payload carries it.
    expect(revealed.ok && 'visibilityChange' in revealed.value).toBe(false);
    expect((await d.entities.get(created.value.id))?.visibility.mode).toBe('players');
    const queued = d.rows.queued.at(-1);
    expect(queued?.expectedVersion).toBe(1);
    expect(
      (queued?.value as unknown as { visibilityChange?: unknown } | undefined)?.visibilityChange,
    ).toEqual({
      operation: 'reveal',
      target: { mode: 'players', playerIds: [PLAYER] },
    });
  });

  test('reveals add players, everyone wins, hiding returns to GM only', async () => {
    const d = revealDevice();
    const created = await d.entities.create({ type: 'handout', name: 'Map' });
    if (!created.ok) throw new Error('create failed');
    const id = created.value.id;
    const step = async (
      change: Parameters<EntityLocalRepository['changeVisibility']>[1],
    ): Promise<EntityRecord> => {
      const current = (await d.entities.get(id)) as EntityRecord;
      const result = await d.entities.changeVisibility(id, change, current.version);
      if (!result.ok) throw new Error(String(result.error));
      return result.value;
    };
    await step({ operation: 'reveal', target: { mode: 'players', playerIds: [PLAYER] } });
    expect(
      (await step({ operation: 'reveal', target: { mode: 'players', playerIds: [OTHER] } }))
        .visibility,
    ).toEqual({ mode: 'players', playerIds: [PLAYER, OTHER].sort() });
    expect((await step({ operation: 'reveal', target: { mode: 'everyone' } })).visibility).toEqual({
      mode: 'everyone',
    });
    expect(
      (await step({ operation: 'unreveal', target: { mode: 'everyone' } })).visibility,
    ).toEqual({ mode: 'gm_only' });
  });

  test('a stale version is refused on the device, and nothing is queued without the unaudited repository', async () => {
    const d = revealDevice();
    const created = await d.entities.create({ type: 'handout', name: 'Seal' });
    if (!created.ok) throw new Error('create failed');
    const stale = await d.entities.changeVisibility(
      created.value.id,
      { operation: 'reveal', target: { mode: 'everyone' } },
      7,
    );
    expect(stale.ok).toBe(false);
    const plain = device();
    const other = await plain.entities.create({ type: 'handout', name: 'Seal' });
    if (!other.ok) throw new Error('create failed');
    expect(
      await plain.entities.changeVisibility(
        other.value.id,
        { operation: 'reveal', target: { mode: 'everyone' } },
        1,
      ),
    ).toEqual(err('not_found'));
  });
});
