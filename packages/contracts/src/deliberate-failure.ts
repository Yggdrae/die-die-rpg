/**
 * DELIBERATE FAILURE — task 02 acceptance criterion.
 *
 * "A deliberately broken commit (a type error) is demonstrated to fail CI."
 *
 * A CI pipeline that has never failed has not been tested. This branch exists to prove the
 * gate catches a real defect, and it is deleted once the run is red.
 *
 * It breaks three gates at once:
 *   typecheck  — Version is an integer, assigned a string
 *   guard      — references a concrete system identifier outside systems/
 *   check      — uses `any`, which biome.json sets to error
 */

import type { Version } from './primitives.ts';

const brokenVersion: Version = 'not a number';

export function branchesOnSystemIdentity(systemId: string): boolean {
  return systemId === 'cairn-2e';
}

export function usesAny(value: any): unknown {
  return value;
}

export const failure = { brokenVersion, branchesOnSystemIdentity, usesAny };
