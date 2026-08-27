/**
 * Frozen contract surface for the whole platform.
 *
 * Types and validators only. No behavior lives here: the moment this package decides
 * something, every feature change becomes a three-way merge, which is the failure the
 * feature split exists to prevent.
 *
 * Changing anything exported from this module after the freeze tag requires a
 * contract-change note in `.speckit/features/00-platform-foundation/` and review from one
 * developer per track, within one working day (feature 00 FR-008).
 */

export * from './actor.ts';
export * from './attachment.ts';
export * from './audit.ts';
export * from './entity.ts';
export * from './error.ts';
export * from './primitives.ts';
export * from './registries.ts';
export * from './repository.ts';
export * from './result.ts';
export * from './semantic-op.ts';
export * from './system.ts';
export * from './validate.ts';
export * from './visibility.ts';
