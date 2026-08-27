import { type Static, Type } from '@sinclair/typebox';
import { Id } from './primitives.ts';

/**
 * Who may see a record (`PRD.md` s.34).
 *
 * Modelled as a discriminated union rather than a mode plus two optional arrays, so
 * "targeted at specific players, with no players" cannot be represented at all.
 *
 * This value is carried by the record. It is not the enforcement: feature 04 decides, and
 * feature 03 filters at the sync boundary. Hiding a record in the interface is not a
 * control, because a record on the device is readable regardless of what is rendered.
 */
export const Visibility = Type.Union(
  [
    Type.Object({ mode: Type.Literal('gm_only') }),
    Type.Object({ mode: Type.Literal('everyone') }),
    Type.Object({
      mode: Type.Literal('party'),
      partyIds: Type.Array(Id, { minItems: 1 }),
    }),
    Type.Object({
      mode: Type.Literal('players'),
      playerIds: Type.Array(Id, { minItems: 1 }),
    }),
  ],
  { $id: 'Visibility' },
);
export type Visibility = Static<typeof Visibility>;

/** Default for anything a GM authors as preparation (`PRD.md` s.34, feature 16 FR-010). */
export const GM_ONLY: Visibility = { mode: 'gm_only' };
