import { describe, expect, test } from 'bun:test';
import type { LocalAuditEntry, LocalAuditLog } from '@rpg/sync';
import { fetchAuditPage } from './audit-api.ts';
import {
  type AuditPageView,
  auditPath,
  canViewPrivate,
  localDescription,
  offlineView,
  onlineView,
} from './audit-model.ts';

const CAMPAIGN = '00000000-0000-4000-8000-0000000000c1';
const GM = '00000000-0000-4000-8000-0000000000a1';
const PLAYER = '00000000-0000-4000-8000-0000000000b1';
const members = [
  { id: GM, username: 'gm_ana' },
  { id: PLAYER, username: 'casey' },
];

function local(
  id: string,
  state: LocalAuditEntry['state'],
  at = '2026-10-26T10:00:00Z',
): LocalAuditEntry {
  return {
    id,
    state,
    campaignId: CAMPAIGN,
    sessionId: null,
    actor: { userId: PLAYER, role: 'player' },
    action: 'campaign.details_updated',
    target: { type: 'campaign', id: CAMPAIGN },
    at,
    before: { name: 'Secret old name' },
    after: { name: 'Secret new name' },
    rendererVersion: 0,
  };
}

const page: AuditPageView = {
  items: [
    {
      id: 'e2',
      sessionId: null,
      actor: { userId: GM, role: 'gm' },
      action: 'campaign.setting_changed',
      target: { type: 'campaign', id: CAMPAIGN },
      acceptedAt: '2026-10-26T14:35:00Z',
      description: { kind: 'registered', text: 'Changed setting torches from 6 to 2.' },
    },
  ],
  total: 1,
  nextCursor: 'e2',
};

describe('audit view model', () => {
  test('online: device-only entries sit above authority history, labeled; total is the API total', () => {
    const log: LocalAuditLog = {
      entries: [local('q1', 'pending'), local('q0', 'rejected'), local('e2', 'accepted')],
      partial: true,
      pendingCount: 1,
    };
    const model = onlineView({ pages: [page], local: log, members });
    expect(model.items.map((item) => [item.id, item.state, item.source])).toEqual([
      ['q1', 'pending', 'device'],
      ['q0', 'rejected', 'device'],
      ['e2', 'accepted', 'authority'],
    ]);
    expect(model.items[2]).toMatchObject({
      actor: 'gm_ana',
      text: 'Changed setting torches from 6 to 2.',
    });
    expect(model.totalLabel).toBe('1 event');
    expect(model.pendingCount).toBe(1);
  });

  test('offline: the replica log, partial marker, no claimed total, never raw values', () => {
    const model = offlineView({
      local: {
        entries: [local('q1', 'pending'), local('a1', 'accepted')],
        partial: true,
        pendingCount: 1,
      },
      members,
    });
    expect(model.totalLabel).toBeUndefined();
    expect(model.partial).toBe(true);
    expect(model.items.map((item) => item.source)).toEqual(['device', 'authority']);
    expect(JSON.stringify(model)).not.toContain('Secret');
    expect(model.items[0]?.text).toBe('Recorded campaign.details_updated on campaign.');
    expect(localDescription({ action: 'Weird Action!', target: { type: 'x', id: CAMPAIGN } })).toBe(
      'Recorded a change.',
    );
  });

  test('filters also narrow device entries', () => {
    const model = onlineView({
      pages: [{ items: [], total: 0 }],
      local: { entries: [local('q1', 'pending')], partial: false, pendingCount: 1 },
      members,
      filters: { actorId: GM },
    });
    expect(model.items).toEqual([]);
  });

  test('private view is a GM-role hint only', () => {
    expect(['owner', 'gm', 'assistant_gm'].map(canViewPrivate)).toEqual([true, true, true]);
    expect(['player', 'observer', undefined].map(canViewPrivate)).toEqual([false, false, false]);
  });

  test('request paths carry only narrowing filters and the cursor', () => {
    expect(auditPath({ campaignId: CAMPAIGN, store: 'campaign' })).toBe(
      `/campaigns/${CAMPAIGN}/audit`,
    );
    expect(
      auditPath({
        campaignId: CAMPAIGN,
        store: 'campaign',
        sessionId: 's1',
        filters: { actorId: GM, targetType: 'campaign' },
        cursor: 'e2',
      }),
    ).toBe(`/campaigns/${CAMPAIGN}/sessions/s1/audit?actorId=${GM}&targetType=campaign&cursor=e2`);
    expect(auditPath({ campaignId: CAMPAIGN, store: 'private', sessionId: 's1' })).toBe(
      `/campaigns/${CAMPAIGN}/audit/private?sessionId=s1`,
    );
  });

  test('API outcomes: page, invalid cursor, safe 404, failure', async () => {
    const respond = (status: number, body: unknown) => async () =>
      new Response(JSON.stringify(body), { status });
    const base = { campaignId: CAMPAIGN, store: 'campaign' as const };
    expect(await fetchAuditPage(base, respond(200, page))).toEqual({ kind: 'page', page });
    expect(
      await fetchAuditPage(
        base,
        respond(400, { code: 'validation_failed', details: { reason: 'invalid_cursor' } }),
      ),
    ).toEqual({ kind: 'invalid_cursor' });
    expect(await fetchAuditPage(base, respond(404, { code: 'not_found' }))).toEqual({
      kind: 'unavailable',
    });
    expect(await fetchAuditPage(base, respond(500, {}))).toEqual({ kind: 'failed' });
    expect(
      await fetchAuditPage(base, async () => {
        throw new Error('offline');
      }),
    ).toEqual({ kind: 'failed' });
  });
});
