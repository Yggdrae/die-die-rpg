/**
 * The shared test corpus for every feature.
 *
 * `.speckit/features/_index.md`, rule 7: until a dependency ships, build against fixtures.
 * Never against a branch owned by another developer. This package is what makes that
 * possible — a feature must be demonstrable against fixtures with the API stack stopped.
 */

export * from './campaign.ts';
export * from './character-schema.ts';
export * from './ids.ts';
