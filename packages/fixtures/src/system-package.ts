import type { SystemRef } from '@rpg/contracts';
import type { SystemPackage } from '@rpg/systems';
import { FIXTURE_CHARACTER_SCHEMA } from './character-schema.ts';
import { FIXTURE_RULES } from './rules.ts';

/**
 * The fixture system is intentionally neither Cairn nor Fate.
 *
 * If Track C builds against a Cairn-shaped fixture, a hidden assumption about Cairn passes
 * every test until wave 3. Using a third shape is the cheapest available check on the
 * architectural criterion in `PRD.md` s.89.
 */
export const FIXTURE_SYSTEM: SystemRef = {
  systemId: 'fixture-system',
  version: '0.1.0',
};

const EXTERNAL_RULES = 'https://example.invalid/fixture-rules';

export const FIXTURE_SYSTEM_PACKAGE: SystemPackage = {
  contractVersion: 1,
  manifest: {
    ref: FIXTURE_SYSTEM,
    name: 'Fixture System',
    shortDescription: 'A generic test system with no product-specific behavior.',
    complexity: 'medium',
    languages: ['en'],
    integration: {
      mechanicsSupported: true,
      characterSheetSupported: true,
      rulesTextIntegrated: true,
      compendiumIntegrated: false,
      externalDocumentation: EXTERNAL_RULES,
    },
    license: {
      license: 'Invented for tests',
      source: EXTERNAL_RULES,
      version: '1',
      attribution: 'Invented test data, rules text included, with no external source.',
      redistributionStatus: 'forbidden',
      translationStatus: 'forbidden',
      brandUsageStatus: 'forbidden',
      assets: {
        // Feature 14 D-17: invented text, so nothing forbids shipping it.
        rulesText: 'allowed',
        mechanics: 'allowed',
        officialArtwork: 'forbidden',
        officialLogo: 'forbidden',
      },
    },
    rulesEntryPoint: EXTERNAL_RULES,
    compatibleModules: [],
  },
  capabilities: ['character_sheet', 'resource_pools', 'integrated_rules'],
  characterSchema: FIXTURE_CHARACTER_SCHEMA,
  resources: [
    {
      key: 'focus',
      label: 'Focus',
      shape: 'pool',
      min: 0,
      max: 6,
      temporary: false,
      visibility: 'everyone',
      spendable: false,
      recovery: [],
    },
    {
      key: 'supplies',
      label: 'Supplies',
      shape: 'pool',
      min: 0,
      max: 10,
      temporary: false,
      visibility: 'everyone',
      spendable: false,
      recovery: [],
    },
  ],
  actions: [],
  mechanics: { conditions: [], ladders: [] },
  rules: FIXTURE_RULES,
  compendiums: [],
  options: [],
  gameModes: [{ id: 'standard', label: 'Standard' }],
};
