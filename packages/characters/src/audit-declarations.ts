import { type TSchema, Type } from '@sinclair/typebox';

/**
 * Feature 15 audit contribution (FR-013). Creation and deletion record the display name and the system;
 * every edit is feature 11's `effect.applied`, with each path's before and after.
 */
export interface CharacterAuditDeclaration {
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

export const CHARACTER_AUDIT_ACTIONS = {
  created: 'character.created',
  deleted: 'character.deleted',
} as const;

export const CharacterAuditValue = Type.Object(
  {
    name: Type.Optional(Type.String({ maxLength: 200 })),
    system: Type.Optional(Type.String({ maxLength: 120 })),
  },
  { additionalProperties: false },
);

function named(prefix: string, value: unknown): string {
  return typeof value === 'string' && value !== ''
    ? `${prefix} "${value.slice(0, 80)}".`
    : `${prefix}.`;
}

export const CHARACTER_AUDIT_DECLARATIONS: readonly CharacterAuditDeclaration[] = [
  {
    action: CHARACTER_AUDIT_ACTIONS.created,
    version: 1,
    payload: CharacterAuditValue,
    render: ({ after }) => ({ text: named('Created the character', after?.name) }),
  },
  {
    action: CHARACTER_AUDIT_ACTIONS.deleted,
    version: 1,
    payload: CharacterAuditValue,
    render: ({ before }) => ({ text: named('Deleted the character', before?.name) }),
  },
];
