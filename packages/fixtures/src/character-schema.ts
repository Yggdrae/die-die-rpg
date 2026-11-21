import type { CharacterSchema } from '@rpg/systems';

/**
 * Fixture character schema, in the feature 08 contract.
 *
 * Deliberately not Cairn and not Fate. It has no attribute named STR, no aspects, no
 * stress track, and no Fate points, so a feature that renders it correctly has rendered
 * something from declarations rather than from a memory of an MVP system. That is the
 * cheapest available test of `PRD.md` s.89, available three waves before the real one.
 *
 * Field types cover enough of the `PRD.md` s.18 component vocabulary for a real sheet:
 * number, resource, select, boolean, text, repeater, and a computed field.
 */
export const FIXTURE_CHARACTER_SCHEMA: CharacterSchema = {
  fields: [
    { key: 'name', label: 'Name', type: 'text', group: 'identity' },
    { key: 'calling', label: 'Calling', type: 'text', group: 'identity' },

    { key: 'VIGOR', label: 'Vigor', type: 'number', group: 'attributes', min: 1, max: 12 },
    { key: 'INSIGHT', label: 'Insight', type: 'number', group: 'attributes', min: 1, max: 12 },

    { key: 'focus', label: 'Focus', type: 'resource', group: 'resources', resourceKey: 'focus' },
    {
      key: 'supplies',
      label: 'Supplies',
      type: 'resource',
      group: 'resources',
      resourceKey: 'supplies',
    },

    {
      key: 'standing',
      label: 'Standing',
      type: 'select',
      group: 'status',
      values: ['unknown', 'tolerated', 'trusted', 'wanted'],
    },
    { key: 'exhausted', label: 'Exhausted', type: 'boolean', group: 'status' },

    {
      key: 'carried',
      label: 'Carried',
      type: 'computed',
      group: 'status',
      // Restricted-language source, evaluated by feature 10. Never JavaScript.
      value: { formula: 'VIGOR + 2' },
    },

    {
      key: 'bonds',
      label: 'Bonds',
      type: 'repeater',
      group: 'bonds',
      of: [
        { key: 'who', label: 'Who', type: 'text', group: 'bonds' },
        { key: 'strength', label: 'Strength', type: 'number', group: 'bonds', min: 1, max: 4 },
      ],
    },

    // Only a GM role may see this field. Feature 04 enforces it.
    { key: 'gmNote', label: 'GM Note', type: 'text', group: 'gm', gmOnly: true },
  ],
  summaryFields: ['name', 'focus'],
};
