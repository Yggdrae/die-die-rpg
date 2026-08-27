import { type Static, Type } from '@sinclair/typebox';
import { Id } from './primitives.ts';

/** Campaign roles (`PRD.md` s.60). A membership carries exactly one. */
export const Role = Type.Union(
  [
    Type.Literal('owner'),
    Type.Literal('gm'),
    Type.Literal('assistant_gm'),
    Type.Literal('player'),
    Type.Literal('observer'),
  ],
  { $id: 'Role' },
);
export type Role = Static<typeof Role>;

/** Roles that act as game master for authorization purposes. */
export const GM_ROLES: readonly Role[] = ['owner', 'gm', 'assistant_gm'];

/**
 * Who is acting, and as what, in one campaign.
 *
 * Resolved by feature 01 and never supplied by a client. A role that arrives in a request
 * body is input, not identity.
 */
export const ActorRef = Type.Object(
  {
    userId: Id,
    campaignId: Id,
    role: Role,
  },
  { $id: 'ActorRef' },
);
export type ActorRef = Static<typeof ActorRef>;
