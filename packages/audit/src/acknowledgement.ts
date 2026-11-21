import type { AuditReadAuthorizer, AuditTargetOccurrence } from './query.ts';

/**
 * Feature 06 retention follow-up: replica acknowledgement of synced audit rows.
 *
 * A replica never sees an authority sequence (gaps would count hidden events), so it names the
 * newest accepted event it durably holds. This resolver turns that ID into the event's sequence
 * for feature 03's watermark store, and only when the event belongs to the campaign in this
 * store and the reader may read it now. Anything else (unknown, foreign, hidden, private to a
 * non-GM) resolves to nothing, the same answer, so the acknowledgement discloses nothing and
 * cannot advance a watermark past rows the replica could not have received.
 */

/** One stored event as an acknowledgement sees it. */
export interface AuditLocatedEvent extends AuditTargetOccurrence {
  readonly sequence: number;
}

export interface AuditEventLocator {
  locate(campaignId: string, eventId: string): Promise<AuditLocatedEvent | undefined>;
}

/** Bound to one physical store at composition, like `AuditQueryService`. */
export class AuditAcknowledgementResolver {
  constructor(private readonly locator: AuditEventLocator) {}

  async resolve(
    campaignId: string,
    eventId: string,
    authorizer: AuditReadAuthorizer,
  ): Promise<number | undefined> {
    const event = await this.locator.locate(campaignId, eventId);
    if (event === undefined) return undefined;
    const readable = await authorizer.permits({
      targetType: event.targetType,
      targetId: event.targetId,
      snapshot: event.snapshot,
    });
    return readable ? event.sequence : undefined;
  }
}
