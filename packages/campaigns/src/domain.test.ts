import { describe, expect, test } from 'bun:test';
import { Type } from '@sinclair/typebox';
import type { CampaignCreateInput, SystemDefinition } from './contracts.ts';
import {
  CampaignSettingRegistry,
  resetSystemDependentState,
  validateCampaignInput,
  wizardSteps,
} from './domain.ts';

export const FIXTURE_SYSTEM: SystemDefinition = {
  summary: {
    ref: { systemId: 'fixture-system', version: '0.1.0' },
    name: 'Fixture System',
    shortDescription: 'A non-MVP fixture system.',
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
  options: [
    { key: 'tone', label: 'Tone', type: 'select', default: 'bright', values: ['bright', 'grim'] },
  ],
  compatibleModules: [{ id: 'weather', version: '1.0.0', name: 'Weather' }],
};

export const CAMPAIGN_INPUT: CampaignCreateInput = {
  id: '11111111-1111-1111-1111-111111111111',
  system: FIXTURE_SYSTEM.summary.ref,
  gameMode: 'standard',
  options: { tone: 'bright' },
  moduleIds: ['weather'],
  name: 'The Road',
  description: 'A campaign.',
};

describe('manifest-driven campaign rules', () => {
  test('derives wizard steps only from declarations', () => {
    expect(wizardSteps(FIXTURE_SYSTEM)).toEqual([
      'system',
      'game_mode',
      'options',
      'modules',
      'details',
      'party',
      'review',
    ]);
    expect(wizardSteps({ ...FIXTURE_SYSTEM, options: [], compatibleModules: [] })).not.toContain(
      'options',
    );
  });

  test('fails closed on unknown modes, options, and modules', () => {
    expect(validateCampaignInput(CAMPAIGN_INPUT, FIXTURE_SYSTEM)).toBeUndefined();
    expect(validateCampaignInput({ ...CAMPAIGN_INPUT, gameMode: 'unknown' }, FIXTURE_SYSTEM)).toBe(
      'invalid_game_mode',
    );
    expect(
      validateCampaignInput({ ...CAMPAIGN_INPUT, options: { tone: 'unknown' } }, FIXTURE_SYSTEM),
    ).toBe('invalid_option');
    expect(
      validateCampaignInput({ ...CAMPAIGN_INPUT, moduleIds: ['unknown'] }, FIXTURE_SYSTEM),
    ).toBe('invalid_module');
  });

  test('system changes clear every dependent choice', () => {
    expect(resetSystemDependentState()).toEqual({
      gameMode: undefined,
      options: {},
      moduleIds: [],
    });
  });

  test('setting registry rejects unknown namespaces and invalid values', () => {
    const registry = new CampaignSettingRegistry();
    registry.register({
      namespace: 'feature.weather',
      schema: Type.Object({ enabled: Type.Boolean() }, { additionalProperties: false }),
      memberVisible: true,
      writableRoles: ['owner'],
    });
    expect(registry.validate('missing', {})).toBe('unregistered_setting_namespace');
    expect(registry.validate('feature.weather', { enabled: 'yes' })).toBe('invalid_setting');
    expect(registry.validate('feature.weather', { enabled: true })).toBeUndefined();
  });
});
