import { type TSchema, Type } from '@sinclair/typebox';

/**
 * Feature 11 audit contribution (FR-010). Structural shape of feature 06's `AuditEventDeclaration`. The
 * values are the paths an application touched, with their values before or after. They inherit the
 * record's Visibility, which is never wider than the target's.
 */
export interface EffectAuditDeclaration {
  readonly action: string;
  readonly version: number;
  readonly payload?: TSchema;
  render(event: {
    readonly action: string;
    readonly targetType: string;
    readonly targetId: string;
    readonly before?: Record<string, unknown>;
    readonly after?: Record<string, unknown>;
    readonly at: string;
  }): { readonly text: string };
}

export const EFFECT_AUDIT_ACTIONS = { applied: 'effect.applied' } as const;

export const EffectAuditValue = Type.Object(
  {
    changes: Type.Array(
      Type.Object(
        {
          path: Type.String({ maxLength: 300 }),
          value: Type.Union([
            Type.Integer(),
            Type.Boolean(),
            Type.String({ maxLength: 500 }),
            Type.Null(),
          ]),
        },
        { additionalProperties: false },
      ),
      { maxItems: 64 },
    ),
  },
  { additionalProperties: false },
);

export const EFFECT_AUDIT_DECLARATIONS: readonly EffectAuditDeclaration[] = [
  {
    action: EFFECT_AUDIT_ACTIONS.applied,
    version: 1,
    payload: EffectAuditValue,
    render: ({ after }) => {
      const changes = Array.isArray(after?.changes) ? after.changes.length : 0;
      return { text: `Applied an effect that changed ${changes} value(s).` };
    },
  },
];
