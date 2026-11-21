import { entitySchema, Id } from '@rpg/contracts';
import { type Static, Type } from '@sinclair/typebox';

/**
 * Replica and input record shapes (`_techspec.md` "Interfaces and Contracts"). Every record is an
 * `EntityEnvelope` through the frozen `entitySchema()`. The schemas fix shape only; the D-11 limits,
 * D-18 tag form, and D-01 field rules are enforced by `domain.ts` (code-point lengths, the unit of
 * the PostgreSQL CHECKs).
 */

/**
 * Feature 17 D-03: the transport-only reveal intent an entity update may carry instead of an audit
 * envelope. The authority hands it to feature 04 `VisibilityService`; it is never stored.
 */
export const EntityVisibilityChange = Type.Object(
  {
    operation: Type.Union([Type.Literal('reveal'), Type.Literal('unreveal')]),
    target: Type.Union([
      Type.Object({ mode: Type.Literal('everyone') }, { additionalProperties: false }),
      Type.Object(
        {
          mode: Type.Literal('players'),
          playerIds: Type.Array(Id, { minItems: 1, maxItems: 100, uniqueItems: true }),
        },
        { additionalProperties: false },
      ),
    ]),
  },
  { additionalProperties: false },
);
export type EntityVisibilityChange = Static<typeof EntityVisibilityChange>;

/** Token shape of a type or kind identifier. */
const ContentToken = Type.String({ pattern: '^[a-z][a-z0-9_]{0,63}$' });

/** Free-form custom fields (D-01): label -> string value. */
export const CustomFields = Type.Record(Type.String({ minLength: 1 }), Type.String());
export type CustomFields = Static<typeof CustomFields>;

/** One campaign entity of any configured type (table `content_entities`). */
export const EntityReplicaSchema = entitySchema(
  {
    type: ContentToken,
    summary: Type.String(),
    description: Type.String(),
    fields: CustomFields,
  },
  { $id: 'ContentEntityRecord' },
);
export type EntityRecord = Static<typeof EntityReplicaSchema>;

/** A player's private note (table `content_personal_notes`); `type` is fixed by the mapping. */
export const PersonalNoteReplicaSchema = entitySchema(
  {
    authorUserId: Id,
    body: Type.String(),
  },
  { $id: 'ContentPersonalNoteRecord' },
);
export type PersonalNoteRecord = Static<typeof PersonalNoteReplicaSchema>;

/**
 * A typed, directed relationship (table `content_entity_relationships`, task 08); `name` is the
 * kind label at mapping time and `tags` is empty.
 */
export const RelationshipReplicaSchema = entitySchema(
  {
    sourceEntityId: Id,
    targetEntityId: Id,
    kind: ContentToken,
  },
  { $id: 'ContentRelationshipRecord' },
);
export type RelationshipRecord = Static<typeof RelationshipReplicaSchema>;

/** Quick create (FR-005): name plus the one optional line; Visibility omitted = policy default. */
export const QuickCreateInput = Type.Object(
  {
    type: ContentToken,
    name: Type.String({ minLength: 1 }),
    summary: Type.Optional(Type.String()),
  },
  { additionalProperties: false, $id: 'ContentQuickCreateInput' },
);
export type QuickCreateInput = Static<typeof QuickCreateInput>;
