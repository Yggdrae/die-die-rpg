import { describe, expect, test } from 'bun:test';
import { ResourcePolicyRegistry, runPolicyConformance } from '@rpg/authorization';
import type { ActorRef, Role } from '@rpg/contracts';
import type { MembershipHistoryFact } from '@rpg/identity';
import { registerResourcePolicies } from '../sync/sync-rules.ts';
import { membershipFactsSource } from './membership-facts.ts';
import { AuditTargetAccess } from './target-access.ts';

/**
 * Feature 06 task 03 follow-up: who may read `campaign_membership` audit events (no database).
 * Rule: owner, gm and assistant_gm read; player, observer and non-members do not. A removed
 * member's history stays readable by those same roles.
 */

const CAMPAIGN = crypto.randomUUID();
const OTHER_CAMPAIGN = crypto.randomUUID();
const MEMBER = crypto.randomUUID();
const REMOVED = crypto.randomUUID();
const STRANGER = crypto.randomUUID();
const READER = crypto.randomUUID();

const facts: MembershipHistoryFact[] = [
  { campaignId: CAMPAIGN, userId: MEMBER, version: 1, removed: false },
  { campaignId: CAMPAIGN, userId: REMOVED, version: 2, removed: true },
  { campaignId: OTHER_CAMPAIGN, userId: STRANGER, version: 1, removed: false },
];
const reader = {
  historyFact: async (campaignId: string, userId: string) =>
    facts.find((fact) => fact.campaignId === campaignId && fact.userId === userId),
};

function access() {
  const registry = registerResourcePolicies(new ResourcePolicyRegistry());
  return new AuditTargetAccess({ registry, sources: [membershipFactsSource(reader)] });
}

const actor = (role: Role): ActorRef => ({ userId: READER, campaignId: CAMPAIGN, role });
const gmOnly = { visibility: { mode: 'gm_only' as const } };
const occurrence = (targetId: string, snapshot: unknown = gmOnly) => ({
  targetType: 'campaign_membership',
  targetId,
  snapshot,
});

describe('campaign_membership audit readers', () => {
  test('the declaration passes registration and the shared conformance matrix', () => {
    const registry = registerResourcePolicies(new ResourcePolicyRegistry());
    expect(registry.get('campaign_membership')?.sync).toEqual({ kind: 'server_only' });
    expect(runPolicyConformance(registry, 'campaign_membership').findings).toEqual([]);
  });

  test('GM roles read current and removed membership history; others never do', async () => {
    const rule: Record<Role, boolean> = {
      owner: true,
      gm: true,
      assistant_gm: true,
      player: false,
      observer: false,
    };
    for (const [role, allowed] of Object.entries(rule) as [Role, boolean][]) {
      for (const targetId of [MEMBER, REMOVED]) {
        const permits = await access()
          .readerFor(actor(role), 'campaign')
          .permits(occurrence(targetId));
        expect({ role, targetId, permits }).toEqual({ role, targetId, permits: allowed });
      }
    }
  });

  test('users with no membership in the campaign, and foreign facts, stay hidden', async () => {
    const owner = access().readerFor(actor('owner'), 'campaign');
    expect(await owner.permits(occurrence(STRANGER))).toBe(false);
    expect(await owner.permits(occurrence(crypto.randomUUID()))).toBe(false);
    const mismatched = new AuditTargetAccess({
      registry: registerResourcePolicies(new ResourcePolicyRegistry()),
      sources: [
        membershipFactsSource({
          historyFact: async () => ({
            campaignId: OTHER_CAMPAIGN,
            userId: MEMBER,
            version: 1,
            removed: false,
          }),
        }),
      ],
    });
    expect(await mismatched.readerFor(actor('owner'), 'campaign').permits(occurrence(MEMBER))).toBe(
      false,
    );
  });

  test('a malformed snapshot or a non-GM-only claim cannot widen the rule', async () => {
    const player = access().readerFor(actor('player'), 'campaign');
    expect(await player.permits(occurrence(MEMBER, { visibility: { mode: 'everyone' } }))).toBe(
      false,
    );
    const owner = access().readerFor(actor('owner'), 'campaign');
    expect(await owner.permits(occurrence(MEMBER, null))).toBe(false);
    expect(await owner.permits(occurrence(MEMBER, { visibility: { mode: 'nobody' } }))).toBe(false);
  });

  test('facts carry no role and are gm_only, and the class has no content-route source', async () => {
    const source = membershipFactsSource(reader);
    expect(await source.loadFacts(CAMPAIGN, REMOVED)).toEqual({
      campaignId: CAMPAIGN,
      resourceClass: 'campaign_membership',
      resourceId: REMOVED,
      visibility: { mode: 'gm_only' },
      version: 2,
    });
    const registry = registerResourcePolicies(new ResourcePolicyRegistry());
    expect(registry.adapterFor('campaign_membership')).toBeUndefined();
  });
});
