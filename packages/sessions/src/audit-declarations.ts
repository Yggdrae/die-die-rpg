import { type TSchema, Type } from '@sinclair/typebox';

/**
 * Feature 18 audit contribution (FR-013, D-14). The authority records each event in the write transaction, with
 * the mutation ID as origin. A scene change records the scene's ID only, never its name, so the event cannot carry
 * a hidden scene's name to a reader of the audit log.
 */
export interface SessionAuditDeclaration {
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

export const SESSION_AUDIT_ACTIONS = {
  started: 'session.started',
  paused: 'session.paused',
  resumed: 'session.resumed',
  ended: 'session.ended',
  sceneChanged: 'session.scene_changed',
} as const;

export const SessionAuditValue = Type.Object(
  {
    number: Type.Optional(Type.Integer({ minimum: 1 })),
    status: Type.Optional(Type.String({ maxLength: 16 })),
    sceneId: Type.Optional(Type.Union([Type.String({ maxLength: 64 }), Type.Null()])),
  },
  { additionalProperties: false },
);

function numbered(prefix: string, value: unknown): string {
  return typeof value === 'number' ? `${prefix} session ${value}.` : `${prefix} the session.`;
}

export const SESSION_AUDIT_DECLARATIONS: readonly SessionAuditDeclaration[] = [
  {
    action: SESSION_AUDIT_ACTIONS.started,
    version: 1,
    payload: SessionAuditValue,
    render: ({ after }) => ({ text: numbered('Started', after?.number) }),
  },
  {
    action: SESSION_AUDIT_ACTIONS.paused,
    version: 1,
    payload: SessionAuditValue,
    render: ({ after }) => ({ text: numbered('Paused', after?.number) }),
  },
  {
    action: SESSION_AUDIT_ACTIONS.resumed,
    version: 1,
    payload: SessionAuditValue,
    render: ({ after }) => ({ text: numbered('Resumed', after?.number) }),
  },
  {
    action: SESSION_AUDIT_ACTIONS.ended,
    version: 1,
    payload: SessionAuditValue,
    render: ({ after }) => ({ text: numbered('Ended', after?.number) }),
  },
  {
    action: SESSION_AUDIT_ACTIONS.sceneChanged,
    version: 1,
    payload: SessionAuditValue,
    render: ({ after }) => ({
      text: after?.sceneId === null ? 'Cleared the current scene.' : 'Changed the current scene.',
    }),
  },
];
