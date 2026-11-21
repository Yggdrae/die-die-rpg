import { describe, expect, test } from 'bun:test';
import { check, SearchDoc } from '@rpg/contracts';
import { EncounterSearchIndexer } from './contributors.ts';
import { ENCOUNTER_RECORD_TYPE, type EncounterRecord } from './records.ts';

/** Feature 20 D-09: the encounter search contributor over a list source. */

const CAMPAIGN = '00000000-0000-4000-8000-000000000001';
const GM = '00000000-0000-4000-8000-000000000002';

function encounter(
  id: string,
  name: string,
  extra: Partial<EncounterRecord> = {},
): EncounterRecord {
  return {
    id,
    campaignId: CAMPAIGN,
    type: ENCOUNTER_RECORD_TYPE,
    name,
    tags: [],
    metadata: {},
    visibility: { mode: 'everyone' },
    version: 1,
    createdAt: '2026-11-06T10:00:00.000Z',
    createdBy: GM,
    updatedAt: '2026-11-06T10:00:00.000Z',
    updatedBy: GM,
    status: 'active',
    startedAt: '2026-11-06T10:00:00.000Z',
    environment: '',
    ...extra,
  };
}

describe('EncounterSearchIndexer', () => {
  test('one valid document per live encounter: name, environment, the stored Visibility', async () => {
    const docs = await new EncounterSearchIndexer({
      listEncounters: async () => [
        encounter('00000000-0000-4000-8000-00000000000b', 'Wolves', {
          environment: 'Moonless, wet ground',
        }),
        encounter('00000000-0000-4000-8000-00000000000a', 'Ford ambush'),
        encounter('00000000-0000-4000-8000-00000000000c', 'Gone', {
          deletedAt: '2026-11-06T11:00:00.000Z',
        }),
      ],
    }).index(CAMPAIGN);
    expect(docs.map((doc) => doc.title)).toEqual(['Ford ambush', 'Wolves']);
    expect(docs[1]).toEqual({
      id: '00000000-0000-4000-8000-00000000000b',
      type: ENCOUNTER_RECORD_TYPE,
      title: 'Wolves',
      body: 'Moonless, wet ground',
      campaignId: CAMPAIGN,
      visibility: { mode: 'everyone' },
    });
    expect(docs.every((doc) => check(SearchDoc, doc))).toBe(true);
  });
});
