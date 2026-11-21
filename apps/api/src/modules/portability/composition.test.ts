import { describe, expect, test } from 'bun:test';
import type { AttachmentRecord } from '@rpg/attachments';
import { MemoryExportJobRepository } from '@rpg/campaign-portability';
import {
  exportContributorProblems,
  importContributorProblems,
} from '@rpg/campaign-portability/testing';
import {
  CampaignImporter,
  type CampaignRecord,
  CampaignSettingRegistry,
  StaticSystemCatalog,
} from '@rpg/campaigns';
import { CharacterExporter } from '@rpg/characters';
import { ContentExporter, type EntityRecord, type RelationshipRecord } from '@rpg/content';
import { ok } from '@rpg/contracts';
import { RollExporter } from '@rpg/dice';
import { FIXTURE_SYSTEM_DEFINITION } from '@rpg/fixtures';
import { createOnlineExport, exportJobAttachmentReferences } from './composition.ts';

/**
 * Feature 07 task 03/04/06: every registered P0 contributor passes the export conformance kit
 * (schema, version, determinism, forbidden-data scan, safe import answer) and the
 * transaction-aware import kit (own export validates, hostile chunks get safe codes), and the
 * feature 05 retention
 * seam holds the attachments of a campaign whose export is in flight.
 */

const CAMPAIGN = '7d3f6a2e-1b0c-4d5e-8f9a-0b1c2d3e4f50';
const OWNER = '1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d';
const PLAYER = '5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b';

const campaign: CampaignRecord = {
  id: CAMPAIGN,
  name: 'Ashen Road',
  description: '',
  system: { systemId: 'fixture-system', version: '0.1.0' },
  gameMode: 'standard',
  modulePins: [],
  settings: {},
  version: 1,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  createdBy: OWNER,
};

function attachment(id: string, visibility: AttachmentRecord['visibility']): AttachmentRecord {
  const at = new Date('2026-10-01T00:00:00.000Z');
  return {
    id,
    campaignId: CAMPAIGN,
    ownerResourceClass: 'fixture_note',
    ownerResourceId: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
    filename: 'map.png',
    mime: 'image/png',
    declaredSize: 10,
    verifiedSize: 10,
    declaredChecksum: 'aa'.repeat(32),
    verifiedChecksum: 'aa'.repeat(32),
    objectKey: `campaigns/${CAMPAIGN}/x/${id}`,
    status: 'ready',
    visibility,
    version: 1,
    createdAt: at,
    updatedAt: at,
    createdBy: OWNER,
    updatedBy: OWNER,
    finalizedAt: at,
    failedAt: undefined,
    deletedAt: undefined,
    purgeAfter: undefined,
    pendingExpired: false,
  };
}

const AT = '2026-10-01T00:00:00.000Z';

function contentEntity(id: string, overrides: Partial<EntityRecord> = {}): EntityRecord {
  return {
    id,
    campaignId: CAMPAIGN,
    type: 'npc',
    name: 'Ferryman',
    tags: [],
    metadata: {},
    visibility: { mode: 'gm_only' },
    version: 1,
    createdAt: AT,
    createdBy: OWNER,
    updatedAt: AT,
    updatedBy: OWNER,
    summary: '',
    description: '',
    fields: { Email: 'not a credential', Auditor: 'a game role' },
    ...overrides,
  };
}

const ENTITY_A = '2a000000-0000-4000-8000-000000000001';
const ENTITY_B = '2a000000-0000-4000-8000-000000000002';
const link: RelationshipRecord = {
  id: '3b000000-0000-4000-8000-000000000001',
  campaignId: CAMPAIGN,
  type: 'relationship',
  name: 'knows',
  tags: [],
  metadata: {},
  visibility: { mode: 'gm_only' },
  version: 1,
  createdAt: AT,
  createdBy: OWNER,
  updatedAt: AT,
  updatedBy: OWNER,
  sourceEntityId: ENTITY_A,
  targetEntityId: ENTITY_B,
  kind: 'knows',
};

const contentExporter = new ContentExporter({
  entities: {
    list: async () => [
      contentEntity(ENTITY_A, { visibility: { mode: 'players', playerIds: [PLAYER] } }),
      contentEntity(ENTITY_B, { deletedAt: AT, version: 2 }),
    ],
  },
  relationships: { list: async () => [link] },
});

describe('registered P0 export contributors', () => {
  test('each passes the conformance kit', async () => {
    const { registry } = createOnlineExport({
      campaigns: { get: async (id) => (id === CAMPAIGN ? campaign : undefined) },
      attachments: {
        listReadyInCampaign: async () => [
          attachment('0f0e0d0c-0b0a-4908-8706-050403020100', { mode: 'gm_only' }),
          attachment('1f1e1d1c-1b1a-4918-8716-151413121110', {
            mode: 'players',
            playerIds: [PLAYER],
          }),
        ],
      },
      content: contentExporter,
      rolls: new RollExporter({ list: async () => [] }),
      characters: new CharacterExporter({ list: async () => [], listSecrets: async () => [] }),
      jobs: new MemoryExportJobRepository(),
      applicationVersion: 'test',
      campaignImporter: new CampaignImporter({
        catalog: new StaticSystemCatalog([FIXTURE_SYSTEM_DEFINITION]),
        settings: new CampaignSettingRegistry(),
        writer: {
          createWithin: async () => {
            throw new Error('validate must never write');
          },
        },
        ownerWriter: { createOwner: async (input) => ok({ ...input, role: 'owner' as const }) },
        unwrap: () => undefined,
      }),
    });
    expect(registry.list().map((entry) => [entry.module.moduleId, entry.placement])).toEqual([
      ['attachments', 'attachments-manifest'],
      ['campaign', 'campaign'],
      ['characters', 'entities'],
      ['content', 'entities'],
      ['dice_rolls', 'entities'],
    ]);
    // Content: two entities (one tombstone a live link references) and one relationship.
    const expected: Record<string, number> = {
      attachments: 2,
      campaign: 1,
      content: 3,
      dice_rolls: 0,
      characters: 0,
    };
    for (const registration of registry.list()) {
      expect(
        await exportContributorProblems(registration, CAMPAIGN, {
          expectedRecords: expected[registration.module.moduleId],
        }),
      ).toEqual([]);
      // Transaction-aware import (contract note 2026-10-27): both P0 contributors implement it.
      expect(await importContributorProblems(registration, CAMPAIGN)).toEqual([]);
    }
  });
});

describe('feature 05 retention seam', () => {
  test('attachments of a campaign with a requested or running export are retained', async () => {
    const jobs = new MemoryExportJobRepository();
    const references = exportJobAttachmentReferences(jobs);
    const rows = [
      { id: 'a', campaignId: CAMPAIGN },
      { id: 'b', campaignId: OWNER },
    ];
    expect(await references.referenced(rows)).toEqual(new Set());
    await jobs.create({ id: crypto.randomUUID(), campaignId: CAMPAIGN, requestedBy: OWNER });
    expect(await references.referenced(rows)).toEqual(new Set(['a']));
    const running = [...jobs.jobs.values()][0];
    await jobs.complete(running?.id ?? '', { manifestChecksum: '0'.repeat(64), summary: [] });
    expect(await references.referenced(rows)).toEqual(new Set());
    expect(await references.referenced([])).toEqual(new Set());
  });
});
