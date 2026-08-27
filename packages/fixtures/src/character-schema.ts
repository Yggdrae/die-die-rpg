/**
 * Fixture character schema.
 *
 * Deliberately not Cairn and not Fate. It has no attribute named STR, no aspects, no
 * stress track, and no Fate points, so a feature that renders it correctly has rendered
 * something from declarations rather than from a memory of an MVP system. That is the
 * cheapest available test of `PRD.md` s.89, available three waves before the real one.
 *
 * PLACEHOLDER SHAPE. Feature 08 owns the real `characterSchema` contract and publishes it
 * early in wave 1 (feature 08 FR-012). Until then this shape is a stand-in that lets
 * feature 15 build. When 08 publishes, this file changes and feature 15 should not.
 *
 * Field types cover enough of the `PRD.md` s.18 component vocabulary for a real sheet:
 * number, resource, select, boolean, text, repeater, and a computed field.
 */

export type FixtureFieldType =
  | 'text'
  | 'number'
  | 'boolean'
  | 'resource'
  | 'select'
  | 'repeater'
  | 'computed';

export interface FixtureField {
  readonly key: string;
  readonly label: string;
  readonly type: FixtureFieldType;
  readonly group: string;
  readonly min?: number;
  readonly max?: number;
  readonly options?: readonly string[];
  /** Restricted-language source, evaluated by feature 10. Never JavaScript. */
  readonly formula?: string;
  readonly of?: readonly FixtureField[];
  /** When true, only a GM role may see the field. Feature 04 enforces it. */
  readonly gmOnly?: boolean;
}

export interface FixtureCharacterSchema {
  readonly systemId: string;
  readonly version: string;
  readonly fields: readonly FixtureField[];
}

export const FIXTURE_CHARACTER_SCHEMA: FixtureCharacterSchema = {
  systemId: 'fixture-system',
  version: '0.1.0',
  fields: [
    { key: 'name', label: 'Name', type: 'text', group: 'identity' },
    { key: 'calling', label: 'Calling', type: 'text', group: 'identity' },

    { key: 'VIGOR', label: 'Vigor', type: 'number', group: 'attributes', min: 1, max: 12 },
    { key: 'INSIGHT', label: 'Insight', type: 'number', group: 'attributes', min: 1, max: 12 },

    {
      key: 'focus',
      label: 'Focus',
      type: 'resource',
      group: 'resources',
      min: 0,
      max: 6,
    },
    {
      key: 'supplies',
      label: 'Supplies',
      type: 'resource',
      group: 'resources',
      min: 0,
      max: 10,
    },

    {
      key: 'standing',
      label: 'Standing',
      type: 'select',
      group: 'status',
      options: ['unknown', 'tolerated', 'trusted', 'wanted'],
    },
    { key: 'exhausted', label: 'Exhausted', type: 'boolean', group: 'status' },

    {
      key: 'carried',
      label: 'Carried',
      type: 'computed',
      group: 'status',
      formula: 'VIGOR + 2',
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

    {
      key: 'gmNote',
      label: 'GM Note',
      type: 'text',
      group: 'gm',
      gmOnly: true,
    },
  ],
};

/** Minimal rules tree for feature 14, same "not an MVP system" constraint. */
export const FIXTURE_RULES = {
  systemId: 'fixture-system',
  version: '0.1.0',
  sections: [
    {
      id: 'intro',
      title: 'Introduction',
      body: 'A placeholder rules tree used to build the library before a real system package exists.',
      children: [],
    },
    {
      id: 'core',
      title: 'Core Mechanics',
      body: 'Roll and compare against an attribute. Placeholder text.',
      children: [
        {
          id: 'core.checks',
          title: 'Checks',
          body: 'Placeholder text for a check. Cross-references resolve to sibling sections.',
          children: [],
        },
      ],
    },
    {
      id: 'harm',
      title: 'Harm and Recovery',
      body: 'Placeholder text. Referenced by core.checks.',
      children: [],
    },
  ],
} as const;
