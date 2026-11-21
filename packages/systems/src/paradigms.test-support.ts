import type { SystemPackage } from './schema.ts';

/**
 * Two invented systems that share almost nothing, carrying every mechanic `PRD.md` s.10 asks of the
 * MVP pair. Written before features 12 and 13 so a contract gap surfaces here, in the contract's own
 * tests, where fixing it is cheap. Neither is a real system, and no rules text is reproduced.
 */

const LICENSE: SystemPackage['manifest']['license'] = {
  license: 'Invented for tests',
  source: 'https://example.invalid/source',
  version: '1',
  attribution: 'Test data with no external source.',
  redistributionStatus: 'allowed',
  translationStatus: 'review-required',
  brandUsageStatus: 'forbidden',
  assets: {
    rulesText: 'allowed',
    mechanics: 'allowed',
    officialArtwork: 'forbidden',
    officialLogo: 'forbidden',
  },
};

/** Rules-light: attributes, protection that spills into them, slots, fatigue, scars, spellbook. */
export function slotSystem(): SystemPackage {
  return {
    contractVersion: 1,
    manifest: {
      ref: { systemId: 'slot-delve', version: '1.0.0' },
      name: 'Slot Delve',
      shortDescription: 'Three attributes, slot inventory, and protection that gives way.',
      complexity: 'low',
      languages: ['en'],
      integration: {
        mechanicsSupported: true,
        characterSheetSupported: true,
        rulesTextIntegrated: true,
        compendiumIntegrated: false,
      },
      license: LICENSE,
      rulesEntryPoint: 'intro',
      compatibleModules: [],
    },
    capabilities: [
      'character_sheet',
      'dice_rolls',
      'resource_pools',
      'conditions',
      'inventory_slots',
      'integrated_rules',
    ],
    characterSchema: {
      fields: [
        { key: 'name', label: 'Name', group: 'identity', type: 'text', maxLength: 80 },
        { key: 'BRAWN', label: 'Brawn', group: 'attributes', type: 'number', min: 0, max: 18 },
        { key: 'AGILITY', label: 'Agility', group: 'attributes', type: 'number', min: 0, max: 18 },
        { key: 'NERVE', label: 'Nerve', group: 'attributes', type: 'number', min: 0, max: 18 },
        {
          key: 'guard',
          label: 'Guard',
          group: 'resources',
          type: 'resource',
          resourceKey: 'guard',
        },
        { key: 'armor', label: 'Armor', group: 'resources', type: 'number', min: 0, max: 3 },
        {
          key: 'pack',
          label: 'Pack',
          group: 'gear',
          type: 'inventory',
          inventoryKey: 'pack',
        },
        { key: 'afflictions', label: 'Afflictions', group: 'status', type: 'condition' },
        {
          key: 'spellbook',
          label: 'Spellbook',
          group: 'gear',
          type: 'repeater',
          of: [
            { key: 'spell', label: 'Spell', group: 'gear', type: 'text' },
            { key: 'description', label: 'Description', group: 'gear', type: 'rich_text' },
          ],
        },
        {
          key: 'marks',
          label: 'Lasting marks',
          group: 'status',
          type: 'list',
        },
        { key: 'level', label: 'Level', group: 'identity', type: 'number', min: 1, default: 1 },
      ],
      summaryFields: ['name', 'guard'],
    },
    resources: [
      {
        key: 'guard',
        label: 'Guard',
        shape: 'pool',
        min: 0,
        max: { formula: 'level + 3' },
        temporary: false,
        visibility: 'everyone',
        spendable: false,
        recovery: [{ trigger: 'short_rest', label: 'A moment of rest restores all of it' }],
      },
    ],
    actions: [
      {
        key: 'save',
        label: 'Save',
        roll: { dice: '1d20' },
        inputs: ['BRAWN', 'AGILITY', 'NERVE'],
        picks: [{ name: 'attribute', label: 'Attribute', fields: ['BRAWN', 'AGILITY', 'NERVE'] }],
        success: { formula: 'roll <= attribute' },
        outcomes: [],
      },
      {
        key: 'take_damage',
        label: 'Take damage',
        roll: { dice: '1d6' },
        inputs: ['armor', 'BRAWN', 'guard'],
        outcomes: [
          {
            id: 'absorbed',
            label: 'Guard absorbs it',
            when: { formula: 'roll - armor <= guard' },
            resolution: {
              mode: 'apply',
              effects: [
                {
                  effect: 'apply_damage',
                  params: { resource: 'guard', amount: { formula: 'roll - armor' } },
                },
              ],
            },
          },
          {
            id: 'spills',
            label: 'Damage spills into an attribute',
            resolution: {
              mode: 'apply',
              effects: [
                { effect: 'modify_field', params: { field: 'BRAWN', amount: -1 } },
                { effect: 'execute_roll', params: { action: 'save' } },
              ],
            },
          },
        ],
      },
    ],
    mechanics: {
      conditions: [
        {
          key: 'fatigue',
          label: 'Fatigue',
          stacking: 'count',
          occupiesSlots: 1,
          visibility: 'everyone',
        },
        { key: 'scar', label: 'Scar', stacking: 'count', visibility: 'everyone' },
      ],
      inventory: { key: 'pack', label: 'Pack', capacity: 10, unit: 'slots' },
      ladders: [],
    },
    rules: {
      sections: [
        {
          id: 'intro',
          title: 'Introduction',
          category: 'introduction',
          body: 'Invented test text.',
          references: ['saves'],
        },
        { id: 'saves', title: 'Saves', category: 'core_mechanics', references: [] },
      ],
    },
    compendiums: [],
    options: [{ key: 'strict-slots', label: 'Strict slots', type: 'boolean', default: true }],
    gameModes: [{ id: 'standard', label: 'Standard' }],
  };
}

/** Narrative: free text that matters, a skill ladder, spent points, box tracks, table choices. */
export function aspectSystem(): SystemPackage {
  return {
    contractVersion: 1,
    manifest: {
      ref: { systemId: 'aspect-tale', version: '2.1.0' },
      name: 'Aspect Tale',
      shortDescription: 'Free-text truths, a rating ladder, and consequences the table decides.',
      complexity: 'medium',
      languages: ['en', 'pt-BR'],
      integration: {
        mechanicsSupported: true,
        characterSheetSupported: true,
        rulesTextIntegrated: false,
        compendiumIntegrated: false,
        externalDocumentation: 'https://example.invalid/aspect-tale',
      },
      license: { ...LICENSE, assets: { ...LICENSE.assets, rulesText: 'forbidden' } },
      rulesEntryPoint: 'https://example.invalid/aspect-tale',
      compatibleModules: [{ id: 'extra-tables', version: '1.0.0', name: 'Extra tables' }],
    },
    capabilities: [
      'character_sheet',
      'dice_rolls',
      'resource_pools',
      'resource_tracks',
      'spendable_points',
      'rating_ladders',
      'freeform_entries',
      'outcome_choices',
    ],
    characterSchema: {
      fields: [
        { key: 'name', label: 'Name', group: 'identity', type: 'text' },
        {
          key: 'truths',
          label: 'Truths',
          group: 'identity',
          type: 'repeater',
          of: [{ key: 'text', label: 'Text', group: 'identity', type: 'text' }],
          entryTypes: [
            { id: 'core', label: 'Core' },
            { id: 'situation', label: 'Situation' },
          ],
        },
        {
          key: 'skills',
          label: 'Skills',
          group: 'skills',
          type: 'repeater',
          of: [
            { key: 'skill', label: 'Skill', group: 'skills', type: 'text' },
            {
              key: 'rating',
              label: 'Rating',
              group: 'skills',
              type: 'number',
              min: 0,
              max: 4,
              ladder: 'ranks',
            },
          ],
        },
        {
          key: 'favor',
          label: 'Favor',
          group: 'resources',
          type: 'resource',
          resourceKey: 'favor',
        },
        { key: 'strain', label: 'Strain', group: 'harm', type: 'resource', resourceKey: 'strain' },
        {
          key: 'lasting_harm',
          label: 'Lasting harm',
          group: 'harm',
          type: 'repeater',
          of: [{ key: 'text', label: 'Text', group: 'harm', type: 'text' }],
          slots: [
            { id: 'mild', label: 'Mild', severity: 2 },
            { id: 'moderate', label: 'Moderate', severity: 4 },
            { id: 'severe', label: 'Severe', severity: 6 },
          ],
        },
      ],
      summaryFields: ['name', 'favor', 'strain'],
    },
    resources: [
      {
        key: 'favor',
        label: 'Favor',
        shape: 'pool',
        min: 0,
        max: 10,
        default: 3,
        temporary: false,
        visibility: 'everyone',
        spendable: true,
        recovery: [{ trigger: 'session_start', label: 'Refresh', amount: 3 }],
      },
      {
        key: 'strain',
        label: 'Strain',
        shape: 'track',
        boxes: [
          { id: 'one', label: '1', value: 1 },
          { id: 'two', label: '2', value: 2 },
        ],
        visibility: 'everyone',
        spendable: false,
        recovery: [{ trigger: 'scene_end', label: 'Clears after the scene' }],
      },
    ],
    actions: [
      {
        key: 'attack',
        label: 'Attack',
        roll: { dice: '4dF + skill' },
        inputs: ['skills'],
        picks: [{ name: 'skill', label: 'Skill', fields: ['skills'], entryField: 'rating' }],
        prompts: [{ name: 'opposition', label: 'Opposition', default: 0 }],
        derived: [{ name: 'margin', value: { formula: 'roll - opposition' } }],
        outcomes: [
          {
            id: 'hit',
            label: 'Shifts landed',
            when: { formula: 'margin > 0' },
            resolution: {
              mode: 'choice',
              options: [
                {
                  id: 'mark_box',
                  label: 'Mark strain',
                  effects: [{ effect: 'mark_box', params: { resource: 'strain' } }],
                },
                {
                  id: 'take_harm',
                  label: 'Take lasting harm',
                  effects: [{ effect: 'fill_slot', params: { field: 'lasting_harm' } }],
                },
                { id: 'concede', label: 'Concede', effects: [] },
              ],
            },
          },
          { id: 'miss', label: 'No shifts', resolution: { mode: 'apply', effects: [] } },
        ],
      },
    ],
    mechanics: {
      conditions: [],
      ladders: [
        {
          key: 'ranks',
          label: 'Ranks',
          steps: [
            { value: 0, label: 'Mediocre' },
            { value: 1, label: 'Average' },
            { value: 2, label: 'Fair' },
            { value: 3, label: 'Good' },
            { value: 4, label: 'Great' },
          ],
        },
      ],
    },
    rules: {
      sections: [{ id: 'intro', title: 'Introduction', category: 'introduction', references: [] }],
    },
    compendiums: [],
    options: [],
    gameModes: [
      { id: 'standard', label: 'Standard' },
      { id: 'one-shot', label: 'One shot' },
    ],
  };
}
