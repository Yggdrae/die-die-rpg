import { describe, expect, test } from 'bun:test';
import {
  CAMPAIGN_ENTITY_POLICY,
  EntityLocalRepository,
  type EntityRecord,
  matchesEntityFilter,
  type RelationshipRecord,
} from '@rpg/content';
import type { Role } from '@rpg/contracts';
import { InMemoryRepository } from '@rpg/contracts/testing';
import { ACTORS, FIXTURE_ENTITIES, NPCS } from '@rpg/fixtures';
import {
  contentAffordances,
  contentErrorMessage,
  customFieldRows,
  fieldsFromRows,
  parseTagInput,
  relationshipViews,
  sortedFields,
  tagOptions,
  tagSuggestions,
  typeLabel,
  typeOptions,
  visibilityOptions,
} from './content-model.ts';

/** Feature 16 task 11/12 model tests over `FIXTURE_ENTITIES` ("The Missing Caravan"). */

const RECORDS: EntityRecord[] = FIXTURE_ENTITIES.map((entity) => ({
  ...entity,
  summary: '',
  description: '',
  fields: {},
}));
const gm = ACTORS.gm as NonNullable<typeof ACTORS.gm>;
const playerA = ACTORS.playerA as NonNullable<typeof ACTORS.playerA>;

function names(records: readonly EntityRecord[]): string[] {
  return records.map((record) => record.name).sort();
}

describe('filters (BDD "Filtering narrows the permitted set")', () => {
  const filtered = (filter: Parameters<typeof matchesEntityFilter>[1]) =>
    names(RECORDS.filter((record) => matchesEntityFilter(record, filter)));

  test.each([
    [
      'type npc',
      { type: 'npc' },
      ['Bandit Leader', 'Guard', 'Merchant', 'Smuggler', 'Traveler', 'Village Elder'],
    ],
    ['tag antagonist', { tag: 'antagonist' }, ['Bandit Leader', 'Smuggler']],
    [
      'visibility gm_only',
      { visibilityMode: 'gm_only' as const },
      [
        'Abandoned Warehouse',
        'Bandit Leader',
        'Broken Seal',
        'Forest Camp',
        'Merchant Ledger',
        'Smuggler',
      ],
    ],
    [
      'type location and tag site',
      { type: 'location', tag: 'site' },
      ['Abandoned Warehouse', 'Forest Camp'],
    ],
  ])('%s', (_label, filter, expected) => {
    expect(filtered(filter)).toEqual(expected);
  });

  test('an empty filter matches everything; tags are normalized before matching', () => {
    expect(filtered({})).toHaveLength(RECORDS.length);
    expect(filtered({ tag: '  ANTAGONIST ' })).toEqual(['Bandit Leader', 'Smuggler']);
    expect(filtered({ type: '', tag: '', nameFragment: '' })).toHaveLength(RECORDS.length);
  });

  test('filter options come from the permitted rows only', () => {
    const playerRows = RECORDS.filter(
      (record) =>
        record.visibility.mode === 'everyone' ||
        (record.visibility.mode === 'players' &&
          record.visibility.playerIds.includes(playerA.userId)),
    );
    expect(visibilityOptions(playerRows)).toEqual(['players', 'everyone']);
    expect(tagOptions(playerRows)).not.toContain('antagonist');
    expect(
      names(playerRows.filter((r) => matchesEntityFilter(r, { visibilityMode: 'gm_only' }))),
    ).toEqual([]);
    expect(visibilityOptions(RECORDS)).toEqual(['gm_only', 'players', 'everyone']);
  });
});

describe('name-fragment search over the local repository (no network)', () => {
  test('case-insensitive, combined with filters, sorted by name', async () => {
    const records = new InMemoryRepository<EntityRecord>();
    records.seed(RECORDS);
    const local = new EntityLocalRepository(records, {
      userId: gm.userId,
      campaignId: gm.campaignId,
    });
    expect(names(await local.list({ nameFragment: 'bandit' }))).toEqual(['Bandit Leader']);
    expect(names(await local.list({ nameFragment: 'AN' }))).toEqual([
      'Abandoned Warehouse',
      'Bandit Leader',
      'Merchant',
      'Merchant Ledger',
    ]);
    expect(names(await local.list({ nameFragment: 'an', type: 'npc' }))).toEqual([
      'Bandit Leader',
      'Merchant',
    ]);
    expect(names(await local.list({ visibilityMode: 'players' }))).toEqual(['Weathered Letter']);
    const all = await local.list();
    expect(all.map((record) => record.name)).toEqual([...all.map((record) => record.name)].sort());
  });
});

describe('labels from type configuration only', () => {
  test('known types use their label; unknown types show the stored id', () => {
    expect(typeLabel('npc')).toBe('NPC');
    expect(typeLabel('vehicle')).toBe('vehicle');
    expect(typeOptions().map((option) => option.label)).toContain('Scenes');
  });
});

describe('tags', () => {
  test('input parsing and suggestions from visible rows', () => {
    expect(parseTagInput(' a, b ,, c ')).toEqual(['a', 'b', 'c']);
    expect(tagSuggestions(RECORDS, 'ha')).toEqual(['handout']);
    expect(tagSuggestions(RECORDS, 'handout, cl')).toEqual(['clue-source']);
    expect(tagSuggestions(RECORDS, 'handout, ')).not.toContain('handout');
  });
});

describe('affordances are read from the declarations (hints, never a role literal)', () => {
  test('mirror the registered capabilities for every role', () => {
    for (const role of ['owner', 'gm', 'assistant_gm', 'player', 'observer'] as Role[]) {
      const caps = CAMPAIGN_ENTITY_POLICY.roleCapabilities[role] as readonly string[];
      const hints = contentAffordances(role);
      expect(hints.createEntities).toBe(caps.includes('create'));
      expect(hints.editEntities).toBe(caps.includes('update'));
      expect(hints.readEntities).toBe(caps.includes('read'));
    }
    expect(contentAffordances('player').personalNotes).toBe(true);
    expect(contentAffordances('gm').personalNotes).toBe(false);
    expect(contentAffordances('gm').linkEntities).toBe(true);
    expect(contentAffordances(undefined)).toEqual({
      readEntities: false,
      createEntities: false,
      editEntities: false,
      deleteEntities: false,
      linkEntities: false,
      personalNotes: false,
    });
    expect(contentAffordances('superuser').createEntities).toBe(false);
  });
});

describe('relationship views (BDD "A GM links an NPC…", "Relationships survive as broken links")', () => {
  const smuggler = RECORDS.find((record) => record.id === NPCS.smuggler) as EntityRecord;
  const guard = RECORDS.find((record) => record.id === NPCS.guard) as EntityRecord;
  const guild: EntityRecord = {
    ...smuggler,
    id: crypto.randomUUID(),
    type: 'faction',
    name: 'River Guild',
  };
  const link = (source: string, target: string, kind: string): RelationshipRecord => ({
    id: crypto.randomUUID(),
    campaignId: smuggler.campaignId,
    type: 'relationship',
    name: kind,
    tags: [],
    metadata: {},
    visibility: { mode: 'gm_only' },
    version: 1,
    createdAt: smuggler.createdAt,
    createdBy: gm.userId,
    updatedAt: smuggler.updatedAt,
    updatedBy: gm.userId,
    sourceEntityId: source,
    targetEntityId: target,
    kind,
  });

  test('labels read in both directions; a deleted endpoint is a broken link', () => {
    const member = link(smuggler.id, guild.id, 'member_of');
    const livesAt = link(guard.id, guild.id, 'lives_at');
    const gone = { ...guard, deletedAt: '2026-10-29T12:00:00Z' };
    const entities = new Map([
      [smuggler.id, smuggler],
      [guild.id, guild],
      [guard.id, gone],
    ]);
    expect(
      relationshipViews([member], smuggler.id, entities).map((row) => [row.label, row.otherName]),
    ).toEqual([['member of', 'River Guild']]);
    const fromGuild = relationshipViews([member, livesAt], guild.id, entities);
    expect(fromGuild.map((row) => [row.label, row.otherName, row.otherDeleted])).toEqual([
      ['has member', 'Smuggler', false],
      ['has resident', 'Guard', true],
    ]);
    expect(relationshipViews([{ ...member, deletedAt: 'x' }], smuggler.id, entities)).toEqual([]);
  });
});

describe('error copy', () => {
  test('rule errors and version conflicts have safe text', () => {
    expect(contentErrorMessage('name_required')).toBe('A name is required.');
    expect(
      contentErrorMessage({
        kind: 'version_conflict',
        id: 'x',
        expectedVersion: 1,
        actualVersion: 2,
      }),
    ).toContain('changed');
    expect(contentErrorMessage('incompatible_visibility')).toContain('visible to more people');
  });
});

describe('custom fields editor (BDD "A GM adds a free-form custom field", D-01)', () => {
  const row = (label: string, value: string, key = label) => ({ key, label, value });
  const many = (count: number) =>
    Array.from({ length: count }, (_, index) => row(`Field ${index}`, 'v', `k${index}`));
  const INVALID: [string, ReturnType<typeof row>[], string][] = [
    [
      'case-insensitive duplicate',
      [row('Price', 'one silver'), row('price', 'two')],
      'duplicate_field_label',
    ],
    ['exact duplicate', [row('Price', 'a', 'a'), row('Price', 'b', 'b')], 'duplicate_field_label'],
    ['33rd field', many(33), 'too_many_fields'],
    ['65-character label', [row('l'.repeat(65), 'v')], 'field_label_too_long'],
    ['1,001-character value', [row('Note', 'v'.repeat(1_001))], 'field_value_too_long'],
    ['value without a label', [row('  ', 'orphan')], 'field_label_empty'],
  ];

  test('editor rows are validated with the device rule before anything is queued', async () => {
    const records = new InMemoryRepository<EntityRecord>();
    const ferryman = { ...(RECORDS[0] as EntityRecord), name: 'Ferryman' };
    records.seed([ferryman]);
    const local = new EntityLocalRepository(records, {
      userId: gm.userId,
      campaignId: gm.campaignId,
    });
    for (const [, rows, code] of INVALID) {
      const fields = fieldsFromRows(rows);
      expect(fields).toEqual({ ok: false, error: code } as never);
    }
    // Every case representable as an object is rejected identically by the device repository.
    for (const [, rows, code] of INVALID.filter(([name]) => name !== 'exact duplicate')) {
      const object = Object.fromEntries(rows.map((entry) => [entry.label, entry.value]));
      expect(await local.update(ferryman.id, { fields: object }, ferryman.version)).toEqual({
        ok: false,
        error: code,
      } as never);
    }
    expect((await local.get(ferryman.id))?.version).toBe(ferryman.version);

    const valid = fieldsFromRows([row(' Price ', 'one silver'), row('', '', 'blank'), ...many(31)]);
    if (!valid.ok) throw new Error(valid.error);
    expect(valid.value.Price).toBe('one silver');
    expect(Object.keys(valid.value)).toHaveLength(32);
    const saved = await local.update(ferryman.id, { fields: valid.value }, ferryman.version);
    expect(saved.ok && saved.value.fields.Price).toBe('one silver');
    expect(saved.ok && saved.value.version).toBe(ferryman.version + 1);
  });

  test('fields are listed sorted by label; rows round-trip; every rule has safe copy', () => {
    const fields = { price: '1', Allegiance: 'Guild', Zone: 'Docks', age: '40' };
    expect(sortedFields(fields).map(([label]) => label)).toEqual([
      'age',
      'Allegiance',
      'price',
      'Zone',
    ]);
    const rows = customFieldRows(fields);
    expect(new Set(rows.map((entry) => entry.key)).size).toBe(4);
    expect(fieldsFromRows(rows)).toEqual({ ok: true, value: fields });
    for (const [, , code] of INVALID) {
      expect(contentErrorMessage(code as never)).not.toBe('The change was not saved.');
    }
  });
});
