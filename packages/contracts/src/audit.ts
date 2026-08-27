import { type Static, Type } from '@sinclair/typebox';
import { ActorRef } from './actor.ts';
import { Id, Metadata, Timestamp } from './primitives.ts';

/**
 * One recorded state change (`PRD.md` s.67).
 *
 * `private` is present from the first commit so feature 06 can route GM-private actions to
 * a separate store with its own sync rule. Filtering a shared store on read is not
 * equivalent: a private row that reaches a player device has already leaked, and a hidden
 * GM mechanic exposed once cannot be un-exposed (`PRD.md` s.48).
 *
 * `before` and `after` inherit the visibility of their target. An audit entry must not
 * become a side channel around feature 04.
 */
export const AuditEvent = Type.Object(
  {
    id: Id,
    campaignId: Id,
    sessionId: Type.Optional(Id),
    actor: ActorRef,
    action: Type.String({ minLength: 1 }),
    targetType: Type.String({ minLength: 1 }),
    targetId: Id,
    before: Type.Optional(Metadata),
    after: Type.Optional(Metadata),
    at: Timestamp,
    private: Type.Boolean(),
  },
  { $id: 'AuditEvent' },
);
export type AuditEvent = Static<typeof AuditEvent>;

/**
 * How a feature records an event without owning storage, ordering, or retention.
 *
 * Recording must never block or fail the originating operation (feature 06 FR-009): a
 * logging fault degrades to a retry, never to a rejected user action.
 */
export interface AuditRecorder {
  record(event: Omit<AuditEvent, 'id'>): Promise<void>;
}
