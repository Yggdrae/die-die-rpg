import { afterAll, describe, expect, test } from 'bun:test';
import type { AuditEvent } from '@rpg/contracts';
import { sql } from 'drizzle-orm';
import type { TargetVisibilitySnapshot } from '../../model.ts';
import { AuditQueryService, type AuditReadAuthorizer } from '../../query.ts';
import { type AuditDiagnostics, DurableAuditRecorder } from '../../recorder.ts';
import { AuditRendererRegistry } from '../../renderers.ts';
import {
  AccountAuditRepository,
  CampaignAuditRepository,
  connectAuditDatabase,
  PostgresAuditRepairOutbox,
  PrivateAuditRepository,
} from './repositories.ts';

/**
 * Feature 06 task 03: the PostgreSQL read surface of each physical store. Authorization itself is
 * the caller's (`AuditReadAuthorizer`); these tests prove the store restricts rows, totals, and
 * cursors to the permitted groups, and that the two stores never answer for each other.
 */

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const candidate = databaseUrl === undefined ? undefined : connectAuditDatabase(databaseUrl);
const connection = await (async () => {
  if (candidate === undefined) return undefined;
  try {
    await candidate.db.execute(sql`select 1 from audit_campaign_events limit 1`);
    return candidate;
  } catch {
    await candidate.close();
    return undefined;
  }
})();
afterAll(async () => connection?.close());

const quiet: AuditDiagnostics = {
  degraded: () => undefined,
  deadLettered: () => undefined,
  repaired: () => undefined,
};

describe.skipIf(connection === undefined)('PostgreSQL audit query surface', () => {
  const db = () => {
    if (connection === undefined) throw new Error('database unavailable');
    return connection.db;
  };
  const campaignStore = () => new CampaignAuditRepository(db());
  const privateStore = () => new PrivateAuditRepository(db());
  const recorder = () =>
    new DurableAuditRecorder({
      campaign: campaignStore(),
      private: privateStore(),
      account: new AccountAuditRepository(db()),
      outbox: new PostgresAuditRepairOutbox(db()),
      registry: new AuditRendererRegistry(),
      diagnostics: quiet,
    });

  async function record(
    campaignId: string,
    overrides: Partial<Omit<AuditEvent, 'id'>> & { snapshot?: TargetVisibilitySnapshot } = {},
  ) {
    const { snapshot, ...event } = overrides;
    const actor = event.actor ?? {
      userId: crypto.randomUUID(),
      campaignId,
      role: 'gm' as const,
    };
    const outcome = await recorder().recordCampaign({
      event: {
        campaignId,
        actor,
        action: 'note.updated',
        targetType: 'note',
        targetId: crypto.randomUUID(),
        before: { title: 'Old' },
        after: { title: 'New' },
        at: '2026-10-26T12:00:00.000Z',
        private: false,
        ...event,
      },
      targetVisibility: snapshot ?? { visibility: { mode: 'everyone' } },
    });
    expect(outcome).toBe('recorded');
  }

  const permitTargets = (...ids: string[]): AuditReadAuthorizer => ({
    permits: async (occurrence) => ids.includes(occurrence.targetId),
  });

  test('rows, totals, and pages come only from permitted groups, newest first', async () => {
    const campaignId = crypto.randomUUID();
    const visible = crypto.randomUUID();
    const hidden = crypto.randomUUID();
    for (let index = 0; index < 7; index += 1) {
      await record(campaignId, { targetId: index % 2 === 0 ? visible : hidden });
    }
    const service = new AuditQueryService(campaignStore(), new AuditRendererRegistry());
    const first = await service.query({ scope: { campaignId }, limit: 3 }, permitTargets(visible));
    if (!first.ok) throw new Error('expected a page');
    expect(first.page.total).toBe(4);
    expect(first.page.items.map((item) => item.target.id)).toEqual([visible, visible, visible]);
    const second = await service.query(
      { scope: { campaignId }, limit: 3, cursor: first.page.nextCursor },
      permitTargets(visible),
    );
    if (!second.ok) throw new Error('expected a page');
    expect(second.page.items).toHaveLength(1);
    expect(second.page.nextCursor).toBeUndefined();
    const rows = await campaignStore().listForCampaign(campaignId, { limit: 20 });
    const expected = rows.filter((row) => row.targetId === visible).map((row) => row.id);
    expect([...first.page.items, ...second.page.items].map((item) => item.id)).toEqual(expected);
  });

  test('a cursor resolves only to a permitted event in the same scope and store', async () => {
    const campaignId = crypto.randomUUID();
    const visible = crypto.randomUUID();
    const hidden = crypto.randomUUID();
    await record(campaignId, { targetId: visible });
    await record(campaignId, { targetId: hidden });
    await record(campaignId, { targetId: visible, private: true });
    const rows = await campaignStore().listForCampaign(campaignId, { limit: 10 });
    const [privateRow] = await privateStore().listForCampaign(campaignId, { limit: 10 });
    const hiddenRow = rows.find((row) => row.targetId === hidden);
    const service = new AuditQueryService(campaignStore(), new AuditRendererRegistry());
    for (const cursor of [hiddenRow?.id, privateRow?.id, crypto.randomUUID()]) {
      expect(
        await service.query({ scope: { campaignId }, cursor }, permitTargets(visible)),
      ).toEqual({ ok: false, reason: 'invalid_cursor' });
    }
    // Another campaign's event is out of scope even when its target would be permitted.
    const otherCampaign = crypto.randomUUID();
    await record(otherCampaign, { targetId: visible });
    const [foreign] = await campaignStore().listForCampaign(otherCampaign, { limit: 1 });
    expect(
      await service.query({ scope: { campaignId }, cursor: foreign?.id }, permitTargets(visible)),
    ).toEqual({ ok: false, reason: 'invalid_cursor' });
  });

  test('groups are split by stored snapshot and compared as jsonb', async () => {
    const campaignId = crypto.randomUUID();
    const target = crypto.randomUUID();
    const author = crypto.randomUUID();
    await record(campaignId, { targetId: target, snapshot: { visibility: { mode: 'gm_only' } } });
    await record(campaignId, {
      targetId: target,
      snapshot: { visibility: { mode: 'gm_only' }, authorUserId: author },
    });
    await record(campaignId, { targetId: target, snapshot: { visibility: { mode: 'everyone' } } });
    const groups = await campaignStore().targetGroups({ campaignId });
    expect(groups).toHaveLength(3);
    const service = new AuditQueryService(campaignStore(), new AuditRendererRegistry());
    const result = await service.query(
      { scope: { campaignId } },
      {
        permits: async ({ snapshot }) =>
          (snapshot as TargetVisibilitySnapshot).authorUserId === author,
      },
    );
    expect(result.ok && result.page.total).toBe(1);
    expect(result.ok && result.page.items).toHaveLength(1);
  });

  test('session, actor, and target filters narrow inside one campaign', async () => {
    const campaignId = crypto.randomUUID();
    const session = crypto.randomUUID();
    const target = crypto.randomUUID();
    const casey = { userId: crypto.randomUUID(), campaignId, role: 'player' as const };
    await record(campaignId, { sessionId: session, targetId: target, actor: casey });
    await record(campaignId, { sessionId: session });
    await record(campaignId, { targetId: target });
    const service = new AuditQueryService(campaignStore(), new AuditRendererRegistry());
    const all: AuditReadAuthorizer = { permits: async () => true };
    const totalOf = async (scope: Parameters<typeof service.query>[0]['scope']) => {
      const result = await service.query({ scope }, all);
      return result.ok ? result.page.total : -1;
    };
    expect(await totalOf({ campaignId })).toBe(3);
    expect(await totalOf({ campaignId, sessionId: session })).toBe(2);
    expect(await totalOf({ campaignId, actorUserId: casey.userId })).toBe(1);
    expect(await totalOf({ campaignId, targetType: 'note', targetId: target })).toBe(2);
    expect(await totalOf({ campaignId, targetType: 'other', targetId: target })).toBe(0);
    const session2 = await service.query({ scope: { campaignId, sessionId: session } }, all);
    expect(session2.ok && session2.page.items.map((item) => item.sessionId)).toEqual([
      session,
      session,
    ]);
  });

  // Scenario Outline: An event is routed to one physical store (reads stay separate too).
  test('the campaign and private stores never answer for each other', async () => {
    const campaignId = crypto.randomUUID();
    const target = crypto.randomUUID();
    await record(campaignId, { targetId: target, action: 'note.campaign' });
    await record(campaignId, { targetId: target, action: 'note.private', private: true });
    const all: AuditReadAuthorizer = { permits: async () => true };
    const registry = new AuditRendererRegistry();
    const campaign = await new AuditQueryService(campaignStore(), registry).query(
      { scope: { campaignId } },
      all,
    );
    const hidden = await new AuditQueryService(privateStore(), registry).query(
      { scope: { campaignId } },
      all,
    );
    expect(campaign.ok && campaign.page.items.map((item) => item.action)).toEqual([
      'note.campaign',
    ]);
    expect(hidden.ok && hidden.page.items.map((item) => item.action)).toEqual(['note.private']);
    expect(campaign.ok && campaign.page.total).toBe(1);
    expect(hidden.ok && hidden.page.total).toBe(1);
  });
});
