import { type Static, Type } from '@sinclair/typebox';
import { Id, Metadata, Tag, Timestamp, Version } from './primitives.ts';
import { Visibility } from './visibility.ts';

/**
 * Fields every persisted, synchronized record carries (`PRD.md` s.30).
 *
 * Three of these are load-bearing for the architecture rather than for any feature:
 *
 * - `version` makes optimistic concurrency possible (`PRD.md` s.57).
 * - `deletedAt` makes tombstoned deletes possible; hard deletes do not survive sync.
 * - `visibility` is required, not optional, so a record cannot be created without an
 *   answer to who may see it.
 *
 * Feature 03 cannot retrofit any of the three. A feature that defines its own record
 * shape without them has opted out of conflict detection and sync-time filtering.
 */
export const EntityEnvelope = Type.Object(
  {
    id: Id,
    campaignId: Id,
    type: Type.String({ minLength: 1 }),
    name: Type.String({ minLength: 1 }),
    tags: Type.Array(Tag),
    metadata: Metadata,
    visibility: Visibility,
    version: Version,
    createdAt: Timestamp,
    createdBy: Id,
    updatedAt: Timestamp,
    updatedBy: Id,
    deletedAt: Type.Optional(Timestamp),
  },
  { $id: 'EntityEnvelope' },
);
export type EntityEnvelope = Static<typeof EntityEnvelope>;

/**
 * Compose a feature record from the envelope plus its own fields.
 *
 * Keeps the three load-bearing fields present without every feature restating them, and
 * keeps the architecture guard able to tell an entity from an arbitrary object.
 */
export function entitySchema<T extends Parameters<typeof Type.Object>[0]>(
  properties: T,
  options?: Parameters<typeof Type.Object>[1],
) {
  return Type.Composite([EntityEnvelope, Type.Object(properties)], options);
}
