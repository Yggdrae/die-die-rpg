import { describe, expect, test } from 'bun:test';
import type { ExportChunk, ImportContext, ImportTransaction } from '@rpg/contracts';
import { ok } from '@rpg/contracts';
import { Type } from '@sinclair/typebox';
import type { CampaignRecord } from './application.ts';
import { StaticSystemCatalog } from './catalog.ts';
import type { SystemDefinition } from './contracts.ts';
import { CampaignSettingRegistry } from './domain.ts';
import { CampaignImporter, SETTING_NOT_RESTORED } from './import.ts';

/**
 * Feature 02 contribution to feature 07's atomic import: validation against the exact pins and
 * creation rules, the importer as sole owner, and settings that never become wider than declared.
 */

const NEW_CAMPAIGN = '00000000-0000-4000-8000-0000000000c9';
const IMPORTER = '00000000-0000-4000-8000-0000000000b9';
const SYSTEM: SystemDefinition = {
  summary: {
    ref: { systemId: 'fixture-system', version: '0.1.0' },
    name: 'Fixture System',
    shortDescription: 'Test system.',
    complexity: 'medium',
    documentationStatus: 'external',
    rulesEntryPoint: 'https://example.invalid/rules',
    integration: {
      mechanicsSupported: true,
      characterSheetSupported: true,
      rulesTextIntegrated: false,
      compendiumIntegrated: false,
      externalDocumentation: 'https://example.invalid/rules',
    },
  },
  gameModes: [{ id: 'standard', label: 'Standard' }],
  options: [{ key: 'difficulty', label: 'Difficulty', type: 'boolean', default: false }],
  compatibleModules: [{ id: 'bestiary', version: '2.0.0', name: 'Bestiary' }],
};

const PAYLOAD = {
  name: '  Ashen Road ',
  description: 'A long road.',
  system: { systemId: 'fixture-system', version: '0.1.0' },
  gameMode: 'standard',
  modulePins: [{ moduleId: 'bestiary', version: '2.0.0' }],
  settings: {
    system: { difficulty: true },
    'feature.secret': { enabled: true },
    'feature.weather': { enabled: false },
    'retired.namespace': { anything: 1 },
  },
};

const chunk = (payload: unknown = PAYLOAD): ExportChunk => ({
  moduleId: 'campaign',
  chunkVersion: '1',
  payload,
});

function importer() {
  const settings = new CampaignSettingRegistry();
  settings.register({
    namespace: 'feature.weather',
    schema: Type.Object({ enabled: Type.Boolean() }, { additionalProperties: false }),
    memberVisible: true,
    writableRoles: ['owner'],
  });
  settings.register({
    namespace: 'feature.secret',
    schema: Type.Object({ enabled: Type.Boolean() }, { additionalProperties: false }),
    memberVisible: false,
    writableRoles: ['owner'],
  });
  const created: {
    handle: unknown;
    record: CampaignRecord;
    visible: Record<string, boolean>;
  }[] = [];
  let fail = false;
  const transaction: ImportTransaction = { brand: 'ImportTransaction' };
  const module = new CampaignImporter({
    catalog: new StaticSystemCatalog([SYSTEM]),
    settings,
    writer: {
      createWithin: async (handle, record, _ownerWriter, memberVisible) => {
        if (fail) throw new Error('duplicate key value with internal detail');
        created.push({
          handle,
          record,
          visible: Object.fromEntries(
            Object.keys(record.settings).map((namespace) => [namespace, memberVisible(namespace)]),
          ),
        });
      },
    },
    ownerWriter: { createOwner: async (input) => ok({ ...input, role: 'owner' as const }) },
    unwrap: (value) => (value === transaction ? 'sql-handle' : undefined),
    now: () => new Date('2026-10-28T10:00:00.000Z'),
  });
  const context: ImportContext = {
    campaignId: NEW_CAMPAIGN,
    importerUserId: IMPORTER,
    mapId: () => undefined,
    transaction,
  };
  return { module, created, context, failNext: () => (fail = true) };
}

describe('CampaignImporter', () => {
  test('validate is write-free and reports unregistered settings', async () => {
    const { module, created } = importer();
    expect(await module.validate(chunk())).toEqual({
      ok: true,
      value: { defines: [], warnings: [{ code: SETTING_NOT_RESTORED, count: 1 }] },
    });
    expect(created).toEqual([]);
    expect(module.importChunkVersions).toEqual(['1']);
  });

  test('restore creates the campaign on the import transaction, owned by the importer', async () => {
    const { module, created, context } = importer();
    expect(await module.restore(chunk(), context)).toEqual({
      ok: true,
      value: { restoredCount: 1, warnings: [] },
    });
    expect(created).toHaveLength(1);
    const [{ handle, record, visible }] = created as [(typeof created)[number]];
    expect(handle).toBe('sql-handle');
    expect(record).toEqual({
      id: NEW_CAMPAIGN,
      name: 'Ashen Road',
      description: 'A long road.',
      system: { systemId: 'fixture-system', version: '0.1.0' },
      gameMode: 'standard',
      modulePins: [{ moduleId: 'bestiary', version: '2.0.0' }],
      settings: {
        system: { difficulty: true },
        'feature.secret': { enabled: true },
        'feature.weather': { enabled: false },
      },
      version: 1,
      createdAt: '2026-10-28T10:00:00.000Z',
      updatedAt: '2026-10-28T10:00:00.000Z',
      createdBy: IMPORTER,
    });
    // A hidden setting stays hidden; nothing becomes member-visible because of the import.
    expect(visible).toEqual({
      system: true,
      'feature.secret': false,
      'feature.weather': true,
    });
  });

  test('exact pins only: a missing system or another module version is refused', async () => {
    const { module, created, context } = importer();
    const cases: [unknown, string][] = [
      [
        { ...PAYLOAD, system: { systemId: 'fixture-system', version: '0.2.0' } },
        'system_unavailable',
      ],
      [
        { ...PAYLOAD, modulePins: [{ moduleId: 'bestiary', version: '2.1.0' }] },
        'module_unavailable',
      ],
      [{ ...PAYLOAD, modulePins: [{ moduleId: 'unknown', version: '1.0.0' }] }, 'invalid_module'],
      [
        {
          ...PAYLOAD,
          modulePins: [
            { moduleId: 'bestiary', version: '2.0.0' },
            { moduleId: 'bestiary', version: '2.0.0' },
          ],
        },
        'campaign_chunk_invalid',
      ],
      [{ ...PAYLOAD, gameMode: 'other' }, 'invalid_game_mode'],
      [{ ...PAYLOAD, settings: { system: { difficulty: 'yes' } } }, 'invalid_option'],
      [{ ...PAYLOAD, settings: { system: [1] } }, 'campaign_chunk_invalid'],
      [{ ...PAYLOAD, settings: { 'feature.secret': { enabled: 'x' } } }, 'invalid_setting'],
      [{ ...PAYLOAD, name: '   ' }, 'invalid_campaign_details'],
      [{ ...PAYLOAD, members: ['someone'] }, 'campaign_chunk_invalid'],
    ];
    for (const [payload, code] of cases) {
      expect(await module.validate(chunk(payload))).toEqual({ ok: false, error: code });
      expect(await module.restore(chunk(payload), context)).toEqual({ ok: false, error: code });
    }
    expect(await module.validate({ ...chunk(), chunkVersion: '2' })).toEqual({
      ok: false,
      error: 'campaign_chunk_invalid',
    });
    expect(created).toEqual([]);
  });

  test('a persistence failure is a safe code; the host rolls the import back', async () => {
    const { module, context, failNext } = importer();
    failNext();
    expect(await module.restore(chunk(), context)).toEqual({
      ok: false,
      error: 'campaign_restore_failed',
    });
  });
});
