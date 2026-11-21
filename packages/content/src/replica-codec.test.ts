import { describe, expect, test } from 'bun:test';
import { CONTENT_REPLICA_TABLES } from './replica.ts';
import {
  ENTITY_ROW_CODEC,
  PERSONAL_NOTE_ROW_CODEC,
  RELATIONSHIP_ROW_CODEC,
} from './replica-codec.ts';
import type { EntityRecord, PersonalNoteRecord, RelationshipRecord } from './schemas.ts';

/** Feature 16 task 11: device record ↔ replica row (browser `SyncedRepository` codec). */

const CAMPAIGN = '00000000-0000-4000-8000-0000000016c1';
const GM = '00000000-0000-4000-8000-0000000016a1';
const PLAYER = '00000000-0000-4000-8000-0000000016a2';
const ID = '00000000-0000-4000-8000-0000000016d1';

const entity: EntityRecord = {
  id: ID,
  campaignId: CAMPAIGN,
  type: 'npc',
  name: 'Smuggler',
  tags: ['antagonist', 'river'],
  metadata: {},
  visibility: { mode: 'players', playerIds: [PLAYER] },
  version: 3,
  createdAt: '2026-10-29T10:00:00.000Z',
  createdBy: GM,
  updatedAt: '2026-10-29T11:00:00.000Z',
  updatedBy: GM,
  summary: 'Runs the night ferry',
  description: '# Notes\n<script>alert(1)</script>',
  fields: { Price: '20 gp' },
};

describe('content replica codecs', () => {
  test('an entity round-trips through exactly the replicated columns', () => {
    const row = ENTITY_ROW_CODEC.toRow(entity);
    expect(Object.keys(row).sort()).toEqual(
      Object.keys(CONTENT_REPLICA_TABLES.content_entities.columns).sort(),
    );
    expect(row.visibility_targets).toBe(JSON.stringify([PLAYER]));
    expect(ENTITY_ROW_CODEC.fromRow({ ...row, id: ID })).toEqual(entity);
  });

  test('provider text forms (JSON text, space-separated microsecond timestamps) normalize', () => {
    const row = {
      ...ENTITY_ROW_CODEC.toRow(entity),
      id: ID,
      tags: '["antagonist", "river"]',
      created_at: '2026-10-29 10:00:00.123456Z',
      updated_at: '2026-10-29T11:00:00Z',
      deleted_at: '2026-10-29 12:00:00Z',
    };
    const record = ENTITY_ROW_CODEC.fromRow(row);
    expect(record?.createdAt).toBe('2026-10-29T10:00:00.123Z');
    expect(record?.deletedAt).toBe('2026-10-29T12:00:00.000Z');
    expect(record?.tags).toEqual(['antagonist', 'river']);
  });

  test('a row that does not map to a valid record is never guessed', () => {
    const row = { ...ENTITY_ROW_CODEC.toRow(entity), id: ID };
    for (const broken of [
      { ...row, visibility_mode: 'players', visibility_targets: '[]' },
      { ...row, visibility_mode: 'secret' },
      { ...row, visibility_mode: 'everyone', visibility_targets: JSON.stringify([PLAYER]) },
      { ...row, tags: '{not json' },
      { ...row, fields: '[1]' },
      { ...row, created_at: 'yesterday' },
      { ...row, id: 'not-a-uuid' },
    ]) {
      expect(ENTITY_ROW_CODEC.fromRow(broken)).toBeUndefined();
    }
  });

  test('personal notes and relationships map their own columns', () => {
    const note: PersonalNoteRecord = {
      ...entity,
      type: 'note',
      authorUserId: PLAYER,
      body: 'Do not trust the ferryman',
      createdBy: PLAYER,
      updatedBy: PLAYER,
    } as PersonalNoteRecord;
    const {
      summary: _s,
      description: _d,
      fields: _f,
      ...noteRecord
    } = note as PersonalNoteRecord & Partial<EntityRecord>;
    const noteRow = PERSONAL_NOTE_ROW_CODEC.toRow(noteRecord as PersonalNoteRecord);
    expect(Object.keys(noteRow).sort()).toEqual(
      Object.keys(CONTENT_REPLICA_TABLES.content_personal_notes.columns).sort(),
    );
    expect(PERSONAL_NOTE_ROW_CODEC.fromRow({ ...noteRow, id: ID })).toEqual(noteRecord);

    const link: RelationshipRecord = {
      id: ID,
      campaignId: CAMPAIGN,
      type: 'relationship',
      name: 'member of',
      tags: [],
      metadata: {},
      visibility: { mode: 'gm_only' },
      version: 1,
      createdAt: entity.createdAt,
      createdBy: GM,
      updatedAt: entity.updatedAt,
      updatedBy: GM,
      sourceEntityId: '00000000-0000-4000-8000-0000000016e1',
      targetEntityId: '00000000-0000-4000-8000-0000000016e2',
      kind: 'member_of',
    };
    const linkRow = RELATIONSHIP_ROW_CODEC.toRow(link);
    expect(Object.keys(linkRow).sort()).toEqual(
      Object.keys(CONTENT_REPLICA_TABLES.content_entity_relationships.columns).sort(),
    );
    expect(RELATIONSHIP_ROW_CODEC.fromRow({ ...linkRow, id: ID })).toEqual(link);
  });

  test('a resubmitted edit keeps the authority Visibility (feature 04 owns it)', () => {
    expect(
      ENTITY_ROW_CODEC.resubmitValue(
        { ...entity, name: 'Mine', visibility: { mode: 'everyone' } },
        { ...entity, name: 'Theirs', visibility: { mode: 'gm_only' } },
      ),
    ).toMatchObject({ name: 'Mine', visibility: { mode: 'gm_only' } });
  });
});
