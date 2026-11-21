import { describe, expect, test } from 'bun:test';
import type { CampaignRecord } from './application.ts';
import { CAMPAIGN_CHUNK_VERSION, CampaignExporter } from './export.ts';

/**
 * Feature 02 contribution to feature 07 (`_db.md`, Lifecycle, Retention, and Export): campaign
 * fields, exact pins, settings; no member identifier, creator, version or tombstone.
 */

const ID = '7d3f6a2e-1b0c-4d5e-8f9a-0b1c2d3e4f50';
const OWNER = '1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d';
const RECORD: CampaignRecord = {
  id: ID,
  name: 'Ashen Road',
  description: 'A long road.',
  system: { systemId: 'fixture-system', version: '0.1.0' },
  gameMode: 'standard',
  modulePins: [{ moduleId: 'fixture-module', version: '1.0.0' }],
  settings: { 'fixture.difficulty': 'hard' },
  version: 4,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-02T00:00:00.000Z',
  createdBy: OWNER,
};

function exporter(record: CampaignRecord | undefined) {
  return new CampaignExporter({ get: async (id) => (id === record?.id ? record : undefined) });
}

describe('CampaignExporter', () => {
  test('exports the campaign root with exact pins and no member identifiers', async () => {
    const chunk = await exporter(RECORD).export(ID);
    expect(chunk).toEqual({
      moduleId: 'campaign',
      chunkVersion: CAMPAIGN_CHUNK_VERSION,
      payload: {
        name: 'Ashen Road',
        description: 'A long road.',
        system: { systemId: 'fixture-system', version: '0.1.0' },
        gameMode: 'standard',
        modulePins: [{ moduleId: 'fixture-module', version: '1.0.0' }],
        settings: { 'fixture.difficulty': 'hard' },
      },
    });
    expect(JSON.stringify(chunk)).not.toContain(OWNER);
    expect(await exporter(RECORD).pins(ID)).toEqual({
      system: { systemId: 'fixture-system', version: '0.1.0' },
      modules: [{ moduleId: 'fixture-module', version: '1.0.0' }],
    });
  });

  test('a deleted or missing campaign has no pins and no chunk', async () => {
    const deleted = exporter({ ...RECORD, deletedAt: '2026-10-03T00:00:00.000Z' });
    expect(await deleted.pins(ID)).toBeUndefined();
    try {
      await deleted.export(ID);
      throw new Error('expected failure');
    } catch (error) {
      expect((error as Error).message).toBe('campaign_unavailable');
    }
    expect(await exporter(undefined).pins(ID)).toBeUndefined();
  });

  test('import validates and reports that creation needs the transaction-aware contract', async () => {
    const campaign = exporter(RECORD);
    const chunk = await campaign.export(ID);
    expect(await campaign.import(ID, chunk)).toEqual({
      ok: false,
      error: 'campaign_import_requires_transaction_contract',
    });
    expect(await campaign.import(ID, { ...chunk, payload: { name: '' } })).toEqual({
      ok: false,
      error: 'campaign_chunk_invalid',
    });
    expect(await campaign.import(ID, { ...chunk, chunkVersion: '2' })).toEqual({
      ok: false,
      error: 'campaign_chunk_invalid',
    });
  });
});
