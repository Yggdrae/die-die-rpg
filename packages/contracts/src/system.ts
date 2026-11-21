import { type Static, Type } from '@sinclair/typebox';

/**
 * A campaign pins one system at one version (`PRD.md` s.66).
 *
 * Versions are immutable once published; a correction ships as a new version. Update is
 * never automatic.
 */
export const SystemRef = Type.Object(
  {
    systemId: Type.String({ minLength: 1, pattern: '^[a-z0-9][a-z0-9-]*$' }),
    version: Type.String({ minLength: 1, pattern: '^\\d+\\.\\d+\\.\\d+$' }),
  },
  { $id: 'SystemRef' },
);
export type SystemRef = Static<typeof SystemRef>;

export function systemRefToString(ref: SystemRef): string {
  return `${ref.systemId}@${ref.version}`;
}

/**
 * What a generic screen is allowed to ask about a system (`PRD.md` s.89).
 *
 * The whole architectural bet: a character sheet, a session screen, an encounter tracker
 * ask `system.capabilities`, never which system this is. A branch on a system identifier
 * fails the architecture guard.
 *
 * Feature 08 owns this closed registry. A capability named after a system, or one with exactly
 * one plausible user, is a system conditional wearing a different name. Adding a key is a contract
 * change on purpose: that friction is what stops keys from becoming system names.
 */
export const CAPABILITY_KEYS = {
  character_sheet: 'Characters render from the declared character schema.',
  dice_rolls: 'Declared actions roll dice.',
  resource_pools: 'Some resources are numeric pools with a current value and bounds.',
  resource_tracks: 'Some resources are tracks of separately marked boxes.',
  spendable_points: 'Some resource is spent as a currency rather than lost as harm.',
  conditions: 'Characters can carry named conditions.',
  inventory_slots: 'Inventory is measured in slots against a capacity.',
  rating_ladders: 'Some values read on a named rating scale.',
  freeform_entries: 'Characters hold free-text entries of a declared kind.',
  outcome_choices: 'Some action outcomes are offered to the table instead of applied.',
  integrated_rules: 'Rules text ships inside the application.',
  compendium: 'The package declares compendiums.',
  turn_order: 'Encounters track whose turn it is.',
} as const;

export type CapabilityKey = keyof typeof CAPABILITY_KEYS;

export const CapabilityKeySchema = Type.Union(
  (Object.keys(CAPABILITY_KEYS) as CapabilityKey[]).map((key) => Type.Literal(key)),
  { $id: 'CapabilityKey' },
);

export function isCapabilityKey(value: string): value is CapabilityKey {
  return Object.hasOwn(CAPABILITY_KEYS, value);
}
