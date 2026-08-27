import { type Static, Type } from '@sinclair/typebox';

/**
 * A state change expressed as intent rather than as a final value (`PRD.md` s.57).
 *
 * Two people adjusting the same resource while offline is normal at a table. `delta(-3)`
 * and `delta(+2)` merge; `set(4)` twice destroys one of them silently, which is the
 * failure `PRD.md` s.80 targets at zero.
 *
 * Use `set` only where the new value genuinely does not depend on the old one, such as
 * renaming a field. Use `clamp` to re-apply declared bounds after a merge.
 */
export const SemanticOp = Type.Union(
  [
    Type.Object({
      op: Type.Literal('delta'),
      path: Type.String({ minLength: 1 }),
      value: Type.Number(),
      reason: Type.Optional(Type.String()),
    }),
    Type.Object({
      op: Type.Literal('set'),
      path: Type.String({ minLength: 1 }),
      value: Type.Unknown(),
      reason: Type.Optional(Type.String()),
    }),
    Type.Object({
      op: Type.Literal('clamp'),
      path: Type.String({ minLength: 1 }),
      min: Type.Optional(Type.Number()),
      max: Type.Optional(Type.Number()),
      reason: Type.Optional(Type.String()),
    }),
  ],
  { $id: 'SemanticOp' },
);
export type SemanticOp = Static<typeof SemanticOp>;
