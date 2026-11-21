import { describe, expect, test } from 'bun:test';
import { AuditAcknowledgementResolver, type AuditLocatedEvent } from './acknowledgement.ts';
import type { AuditTargetOccurrence } from './query.ts';

const CAMPAIGN = '00000000-0000-4000-8000-0000000000c1';
const VISIBLE = '00000000-0000-4000-8000-0000000000e1';
const HIDDEN = '00000000-0000-4000-8000-0000000000e2';

/**
 * Retention follow-up: a replica's audit acknowledgement resolves to a sequence only for an event
 * of this store and campaign that the reader may read now; every other case is the same nothing.
 */
describe('AuditAcknowledgementResolver', () => {
  const events: Record<string, AuditLocatedEvent> = {
    [VISIBLE]: {
      targetType: 'campaign',
      targetId: CAMPAIGN,
      snapshot: { visibility: { mode: 'everyone' } },
      sequence: 12,
    },
    [HIDDEN]: {
      targetType: 'campaign',
      targetId: CAMPAIGN,
      snapshot: { visibility: { mode: 'gm_only' } },
      sequence: 13,
    },
  };
  const asked: AuditTargetOccurrence[] = [];
  const resolver = new AuditAcknowledgementResolver({
    locate: async (campaignId, eventId) => (campaignId === CAMPAIGN ? events[eventId] : undefined),
  });
  const player = {
    permits: async (occurrence: AuditTargetOccurrence) => {
      asked.push(occurrence);
      return (
        (occurrence.snapshot as { visibility: { mode: string } }).visibility.mode === 'everyone'
      );
    },
  };

  test('a readable event resolves to its sequence; the decision sees target and snapshot', async () => {
    expect(await resolver.resolve(CAMPAIGN, VISIBLE, player)).toBe(12);
    expect(asked.at(-1)).toEqual({
      targetType: 'campaign',
      targetId: CAMPAIGN,
      snapshot: { visibility: { mode: 'everyone' } },
    });
  });

  test('hidden, unknown, and foreign events resolve to nothing', async () => {
    expect(await resolver.resolve(CAMPAIGN, HIDDEN, player)).toBeUndefined();
    expect(await resolver.resolve(CAMPAIGN, crypto.randomUUID(), player)).toBeUndefined();
    const before = asked.length;
    expect(await resolver.resolve(crypto.randomUUID(), VISIBLE, player)).toBeUndefined();
    // An event that is not found is never shown to the authorizer.
    expect(asked.length).toBe(before);
  });
});
