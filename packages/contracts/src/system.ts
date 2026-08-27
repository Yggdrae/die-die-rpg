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
 * Feature 08 owns the closed registry of values. Wave 0 ships only the branded type so
 * consumers compile; the union is filled in wave 1 once both MVP packages are drafted.
 * A capability named after a system, or one with exactly one plausible user, is a system
 * conditional wearing a different name.
 */
declare const CapabilityKeyBrand: unique symbol;
export type CapabilityKey = string & { readonly [CapabilityKeyBrand]: true };

export const CapabilityKeySchema = Type.String({ minLength: 1, $id: 'CapabilityKey' });

export function capabilityKey(value: string): CapabilityKey {
  return value as CapabilityKey;
}
