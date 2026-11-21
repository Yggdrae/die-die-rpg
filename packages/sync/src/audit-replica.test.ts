import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import {
  AUDIT_LOCAL_BUDGET_BYTES,
  AUDIT_PRIVATE_STREAM,
  AuditReplicaStore,
  type AuditSqlDatabase,
  type AuditStreams,
  AuditWindowManager,
  auditMonth,
  planAuditWindow,
} from './audit-replica.ts';

/**
 * Feature 06 task 04, local side: window planning (10 MB, newest 90 days), merged reads (pending
 * above accepted, partial marker), and window subscriptions per role. The browser replica runs
 * the same SQL through PowerSync; here the tables are plain SQLite tables with the same columns.
 */

const MB = 1024 * 1024;
const NOW = new Date('2026-10-26T12:00:00Z');
const CAMPAIGN = '00000000-0000-4000-8000-0000000000c1';
const OTHER = '00000000-0000-4000-8000-0000000000c2';
const GM = '00000000-0000-4000-8000-0000000000a1';
const PLAYER = '00000000-0000-4000-8000-0000000000b1';

describe('planAuditWindow', () => {
  test('the newest 90 days stay local even above the 10 MB allocation', () => {
    const plan = planAuditWindow({
      now: NOW,
      current: [],
      usage: { '2026-10': 6 * MB, '2026-09': 6 * MB, '2026-08': 1 * MB, '2026-07': 1 * MB },
      historyStart: '2026-01',
    });
    // 2026-07-28 is 90 days back: July overlaps the window.
    expect(plan.months).toEqual(['2026-10', '2026-09', '2026-08', '2026-07']);
    expect(plan.evicted).toEqual([]);
    expect(plan.bytes).toBe(14 * MB);
    expect(plan.partial).toBe(true);
  });

  test('older months are kept newest first within the budget; the first misfit and older go', () => {
    const plan = planAuditWindow({
      now: NOW,
      current: ['2026-06', '2026-05', '2026-04', '2026-03'],
      usage: {
        '2026-10': 2 * MB,
        '2026-09': 2 * MB,
        '2026-08': 1 * MB,
        '2026-07': 1 * MB,
        '2026-06': 3 * MB,
        '2026-05': 2 * MB,
        '2026-04': 0.5 * MB,
        '2026-03': 0.5 * MB,
      },
      historyStart: '2026-01',
    });
    expect(plan.months).toEqual(['2026-10', '2026-09', '2026-08', '2026-07', '2026-06']);
    // April would fit after May was skipped, but eviction is by age: newest kept, older dropped.
    expect(plan.evicted).toEqual(['2026-05', '2026-04', '2026-03']);
    expect(plan.bytes).toBeLessThanOrEqual(AUDIT_LOCAL_BUDGET_BYTES);
    expect(plan.partial).toBe(true);
  });

  test('with room, one older month is added per plan back to the campaign start', () => {
    const first = planAuditWindow({
      now: NOW,
      current: [],
      usage: { '2026-10': 1000 },
      historyStart: '2026-06',
    });
    expect(first.months).toEqual(['2026-10', '2026-09', '2026-08', '2026-07', '2026-06']);
    expect(first.partial).toBe(true);
    const full = planAuditWindow({
      now: NOW,
      current: first.months,
      usage: { '2026-10': 1000 },
      historyStart: '2026-06',
    });
    expect(full.months).toEqual(first.months);
    expect(full.partial).toBe(false);
  });

  test('a young campaign subscribes nothing before its start; unknown start is partial', () => {
    expect(planAuditWindow({ now: NOW, current: [], usage: {}, historyStart: '2026-10' })).toEqual({
      months: ['2026-10'],
      evicted: [],
      partial: false,
      bytes: 0,
    });
    expect(planAuditWindow({ now: NOW, current: [], usage: {} }).partial).toBe(true);
    expect(auditMonth(new Date('2026-01-31T23:59:59Z'))).toBe('2026-01');
  });
});

function sqlite(): { db: Database; port: AuditSqlDatabase } {
  const db = new Database(':memory:');
  const audit = `(id TEXT PRIMARY KEY, campaign_id TEXT, session_id TEXT, actor_user_id TEXT,
    actor_role TEXT, action TEXT, target_type TEXT, target_id TEXT, before_value TEXT,
    after_value TEXT, client_recorded_at TEXT, accepted_at TEXT, renderer_version INTEGER)`;
  db.run(`CREATE TABLE audit_campaign_events ${audit}`);
  db.run(`CREATE TABLE audit_private_events ${audit}`);
  db.run(`CREATE TABLE sync_pending_mutations (id TEXT PRIMARY KEY, campaign_id TEXT, state TEXT,
    payload TEXT, recorded_at TEXT, causal_sequence INTEGER)`);
  db.run(`CREATE TABLE sync_audit_window (id TEXT PRIMARY KEY, campaign_id TEXT, months TEXT,
    partial INTEGER, bytes INTEGER, private_subscribed INTEGER, planned_at TEXT)`);
  const params = (values?: unknown[]) => (values ?? []) as never[];
  return {
    db,
    port: {
      execute: async (sql, values) => db.query(sql).run(...params(values)),
      getAll: async <T>(sql: string, values?: unknown[]) =>
        db.query(sql).all(...params(values)) as T[],
      getOptional: async <T>(sql: string, values?: unknown[]) =>
        (db.query(sql).get(...params(values)) as T | null) ?? null,
    },
  };
}

function accepted(
  db: Database,
  table: 'audit_campaign_events' | 'audit_private_events',
  input: { id: string; at: string; campaign?: string; actor?: string; target?: string },
): void {
  db.query(
    `INSERT INTO ${table} VALUES (?, ?, NULL, ?, 'gm', 'campaign.details_updated', 'campaign', ?,
      '{"name":"Before"}', '{"name":"After"}', ?, ?, 1)`,
  ).run(
    input.id,
    input.campaign ?? CAMPAIGN,
    input.actor ?? GM,
    input.target ?? CAMPAIGN,
    input.at,
    input.at,
  );
}

function queued(
  db: Database,
  input: { id: string; state: string; sequence: number; private?: boolean; actor?: string },
): void {
  const audit = {
    campaignId: CAMPAIGN,
    actor: { userId: input.actor ?? PLAYER, campaignId: CAMPAIGN, role: 'player' },
    action: 'campaign.details_updated',
    targetType: 'campaign',
    targetId: CAMPAIGN,
    before: { name: 'Old' },
    after: { name: 'New' },
    at: '2026-03-01T00:00:00Z',
    private: input.private === true,
  };
  db.query('INSERT INTO sync_pending_mutations VALUES (?, ?, ?, ?, ?, ?)').run(
    input.id,
    CAMPAIGN,
    input.state,
    JSON.stringify({ value: {}, audit }),
    `2026-03-01T00:00:0${input.sequence}Z`,
    input.sequence,
  );
}

describe('AuditReplicaStore', () => {
  test('pending events sit above accepted history, labeled, in queue order', async () => {
    const { db, port } = sqlite();
    accepted(db, 'audit_campaign_events', { id: 'a-old', at: '2026-10-01T10:00:00Z' });
    accepted(db, 'audit_campaign_events', { id: 'a-new', at: '2026-10-02T10:00:00Z' });
    accepted(db, 'audit_campaign_events', {
      id: 'other',
      at: '2026-10-03T10:00:00Z',
      campaign: OTHER,
    });
    queued(db, { id: 'q1', state: 'pending', sequence: 1 });
    queued(db, { id: 'q2', state: 'uploading', sequence: 2 });
    queued(db, { id: 'q3', state: 'rejected', sequence: 3 });
    queued(db, { id: 'q4', state: 'conflicted', sequence: 4 });
    queued(db, { id: 'q5', state: 'accepted', sequence: 5 });
    queued(db, { id: 'q6', state: 'pending', sequence: 6, private: true });
    const store = new AuditReplicaStore(port, () => true);
    const read = await store.read({ campaignId: CAMPAIGN, store: 'campaign' });
    if (!read.ok) throw new Error('readable');
    expect(read.log.entries.map((entry) => [entry.id, entry.state])).toEqual([
      ['q4', 'conflicted'],
      ['q3', 'rejected'],
      ['q2', 'pending'],
      ['q1', 'pending'],
      ['a-new', 'accepted'],
      ['a-old', 'accepted'],
    ]);
    expect(read.log.pendingCount).toBe(2);
    // No window planned yet: local history is partial until synchronized.
    expect(read.log.partial).toBe(true);
    expect(read.log.entries[4]?.before).toEqual({ name: 'Before' });
    const gmPrivate = await store.read({ campaignId: CAMPAIGN, store: 'private' });
    if (!gmPrivate.ok) throw new Error('GM replica holds the private table');
    expect(gmPrivate.log.entries.map((entry) => entry.id)).toEqual(['q6']);
  });

  test('filters narrow both pending and accepted entries', async () => {
    const { db, port } = sqlite();
    accepted(db, 'audit_campaign_events', { id: 'by-gm', at: '2026-10-01T10:00:00Z' });
    accepted(db, 'audit_campaign_events', {
      id: 'by-player',
      at: '2026-10-02T10:00:00Z',
      actor: PLAYER,
    });
    queued(db, { id: 'q-player', state: 'pending', sequence: 1 });
    queued(db, { id: 'q-gm', state: 'pending', sequence: 2, actor: GM });
    const store = new AuditReplicaStore(port, () => false);
    const read = await store.read({ campaignId: CAMPAIGN, store: 'campaign', actorUserId: PLAYER });
    expect(read.ok && read.log.entries.map((entry) => entry.id)).toEqual(['q-player', 'by-player']);
    const target = await store.read({
      campaignId: CAMPAIGN,
      store: 'campaign',
      targetType: 'campaign',
      targetId: OTHER,
    });
    expect(target.ok && target.log.entries).toEqual([]);
  });

  test('without the private table there is nothing to address', async () => {
    const { port } = sqlite();
    const store = new AuditReplicaStore(port, () => false);
    expect(await store.read({ campaignId: CAMPAIGN, store: 'private' })).toEqual({
      ok: false,
      reason: 'private_unavailable',
    });
  });

  test('usage counts both stores per accepted month; history starts at campaign creation', async () => {
    const { db, port } = sqlite();
    accepted(db, 'audit_campaign_events', { id: 'c1', at: '2026-10-01T10:00:00Z' });
    accepted(db, 'audit_private_events', { id: 'p1', at: '2026-10-01T10:00:00Z' });
    accepted(db, 'audit_campaign_events', { id: 'c2', at: '2026-09-01T10:00:00Z' });
    const gmUsage = await new AuditReplicaStore(port, () => true).usage(CAMPAIGN);
    const playerUsage = await new AuditReplicaStore(port, () => false).usage(CAMPAIGN);
    expect(Object.keys(gmUsage).sort()).toEqual(['2026-09', '2026-10']);
    expect(gmUsage['2026-10']).toBe(2 * (gmUsage['2026-09'] ?? 0));
    expect(playerUsage['2026-10']).toBe(playerUsage['2026-09']);
    const created = async (id: string) => (id === CAMPAIGN ? '2026-02-14T09:00:00Z' : undefined);
    expect(await new AuditReplicaStore(port, () => false, created).historyStart(CAMPAIGN)).toBe(
      '2026-02',
    );
    expect(
      await new AuditReplicaStore(port, () => false, created).historyStart(OTHER),
    ).toBeUndefined();
  });
});

/** Records every call the manager makes to the provider streams. */
function fakeStreams() {
  const calls: string[] = [];
  const streams: AuditStreams = {
    subscribe: async (stream, parameters) => {
      calls.push(`subscribe ${stream} ${parameters.month}`);
      return { unsubscribe: () => calls.push(`unsubscribe ${stream} ${parameters.month}`) };
    },
    forget: async (stream, parameters) => {
      calls.push(`forget ${stream} ${parameters.month}`);
    },
  };
  return { calls, streams };
}

describe('AuditWindowManager', () => {
  test('a player subscribes the campaign store only and never addresses the private stream', async () => {
    const { port } = sqlite();
    const { calls, streams } = fakeStreams();
    const manager = new AuditWindowManager(
      new AuditReplicaStore(
        port,
        () => false,
        async () => '2026-09-10T00:00:00Z',
      ),
      streams,
      () => NOW,
    );
    const plan = await manager.refresh(CAMPAIGN, { privateStore: false });
    expect(plan.months).toEqual(['2026-10', '2026-09']);
    expect(manager.active()).toEqual([
      `campaign_audit|${CAMPAIGN}|2026-09`,
      `campaign_audit|${CAMPAIGN}|2026-10`,
    ]);
    await manager.refresh(CAMPAIGN, { privateStore: false });
    expect(calls.some((call) => call.includes(AUDIT_PRIVATE_STREAM))).toBe(false);
    await manager.forgetCampaign(CAMPAIGN, { months: plan.months, privateSubscribed: false });
    expect(manager.active()).toEqual([]);
    expect(calls.some((call) => call.includes(AUDIT_PRIVATE_STREAM))).toBe(false);
  });

  test('a GM subscribes both stores; demotion forgets every private window', async () => {
    const { port } = sqlite();
    const { calls, streams } = fakeStreams();
    const manager = new AuditWindowManager(
      new AuditReplicaStore(
        port,
        () => true,
        async () => '2026-10-01T00:00:00Z',
      ),
      streams,
      () => NOW,
    );
    await manager.refresh(CAMPAIGN, { privateStore: true });
    expect(manager.active()).toEqual([
      `campaign_audit|${CAMPAIGN}|2026-10`,
      `gm_private_audit|${CAMPAIGN}|2026-10`,
    ]);
    calls.length = 0;
    await manager.refresh(CAMPAIGN, { privateStore: false });
    expect(manager.active()).toEqual([`campaign_audit|${CAMPAIGN}|2026-10`]);
    expect(calls).toEqual([
      'unsubscribe gm_private_audit 2026-10',
      'forget gm_private_audit 2026-10',
    ]);
  });

  test('compaction evicts by unsubscribing; pending events and both stores stay untouched', async () => {
    const { db, port } = sqlite();
    const big = 'x'.repeat(900_000);
    for (const [index, month] of ['2026-10', '2026-06', '2026-05', '2026-04'].entries()) {
      for (const table of ['audit_campaign_events', 'audit_private_events'] as const) {
        db.query(
          `INSERT INTO ${table} VALUES (?, ?, NULL, ?, 'gm', 'probe', 'campaign', ?, ?, NULL,
            ?, ?, 1)`,
        ).run(
          `${table}-${index}`,
          CAMPAIGN,
          GM,
          CAMPAIGN,
          big,
          `${month}-02T00:00:00Z`,
          `${month}-02T00:00:00Z`,
        );
      }
    }
    queued(db, { id: 'old-pending', state: 'pending', sequence: 1 });
    const store = new AuditReplicaStore(
      port,
      () => true,
      async () => '2025-01-01T00:00:00Z',
    );
    await store.saveWindow(
      CAMPAIGN,
      {
        months: ['2026-10', '2026-09', '2026-08', '2026-07', '2026-06', '2026-05', '2026-04'],
        evicted: [],
        partial: true,
        bytes: 0,
      },
      true,
      NOW.toISOString(),
    );
    const { calls, streams } = fakeStreams();
    const counts = () =>
      ['audit_campaign_events', 'audit_private_events'].map(
        (table) => (db.query(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n,
      );
    const before = counts();
    const plan = await new AuditWindowManager(store, streams, () => NOW).refresh(CAMPAIGN, {
      privateStore: true,
    });
    // Each month holds ~3.6 MB estimated (two stores, two copies): October + June fit, May does not.
    expect(plan.months).toEqual(['2026-10', '2026-09', '2026-08', '2026-07', '2026-06']);
    expect(plan.evicted).toEqual(['2026-05', '2026-04']);
    expect(calls.filter((call) => call.startsWith('forget')).sort()).toEqual([
      'forget campaign_audit 2026-04',
      'forget campaign_audit 2026-05',
      'forget gm_private_audit 2026-04',
      'forget gm_private_audit 2026-05',
    ]);
    // The provider removes evicted rows; the manager never deletes, copies, or moves any row.
    expect(counts()).toEqual(before);
    const read = await store.read({ campaignId: CAMPAIGN, store: 'campaign' });
    expect(read.ok && read.log.entries[0]?.id).toBe('old-pending');
    expect(read.ok && read.log.partial).toBe(true);
    expect((await store.window(CAMPAIGN))?.months).toEqual([...plan.months]);
  });
});

describe('AuditWindowManager.acknowledgements (retention follow-up)', () => {
  function synced(streams: AuditStreams, pending: Set<string>): AuditStreams {
    return {
      ...streams,
      synced: (stream, parameters) => !pending.has(`${stream} ${parameters.month}`),
    };
  }

  test('names the newest held event per store once every window month has synced', async () => {
    const { db, port } = sqlite();
    accepted(db, 'audit_campaign_events', { id: 'c-old', at: '2026-09-12T00:00:00Z' });
    accepted(db, 'audit_campaign_events', { id: 'c-new', at: '2026-10-20T00:00:00Z' });
    accepted(db, 'audit_campaign_events', {
      id: 'c-other',
      at: '2026-10-25T00:00:00Z',
      campaign: OTHER,
    });
    accepted(db, 'audit_private_events', { id: 'p-new', at: '2026-10-02T00:00:00Z' });
    const pending = new Set(['gm_private_audit 2026-09']);
    const manager = new AuditWindowManager(
      new AuditReplicaStore(
        port,
        () => true,
        async () => '2026-09-10T00:00:00Z',
      ),
      synced(fakeStreams().streams, pending),
      () => NOW,
    );
    // Nothing planned yet: no window, no claim.
    expect(await manager.acknowledgements(CAMPAIGN)).toEqual([]);
    await manager.refresh(CAMPAIGN, { privateStore: true });
    // A private month still downloading holds back only the private claim.
    expect(await manager.acknowledgements(CAMPAIGN)).toEqual([
      { campaignId: CAMPAIGN, tableName: 'audit_campaign_events', throughEventId: 'c-new' },
    ]);
    pending.clear();
    expect(await manager.acknowledgements(CAMPAIGN)).toEqual([
      { campaignId: CAMPAIGN, tableName: 'audit_campaign_events', throughEventId: 'c-new' },
      { campaignId: CAMPAIGN, tableName: 'audit_private_events', throughEventId: 'p-new' },
    ]);
  });

  test('a player claims the campaign store only; nothing held or no sync status claims nothing', async () => {
    const { db, port } = sqlite();
    accepted(db, 'audit_private_events', { id: 'p-leak', at: '2026-10-02T00:00:00Z' });
    const store = new AuditReplicaStore(
      port,
      () => false,
      async () => '2026-10-01T00:00:00Z',
    );
    const manager = new AuditWindowManager(
      store,
      synced(fakeStreams().streams, new Set()),
      () => NOW,
    );
    await manager.refresh(CAMPAIGN, { privateStore: false });
    // No campaign event held yet: the watermark does not move.
    expect(await manager.acknowledgements(CAMPAIGN)).toEqual([]);
    accepted(db, 'audit_campaign_events', { id: 'c-1', at: '2026-10-05T00:00:00Z' });
    expect(await manager.acknowledgements(CAMPAIGN)).toEqual([
      { campaignId: CAMPAIGN, tableName: 'audit_campaign_events', throughEventId: 'c-1' },
    ]);
    // A port without stream status never claims anything.
    const blind = new AuditWindowManager(store, fakeStreams().streams, () => NOW);
    await blind.refresh(CAMPAIGN, { privateStore: false });
    expect(await blind.acknowledgements(CAMPAIGN)).toEqual([]);
  });

  test('a window month not subscribed on this device (restart before refresh) claims nothing', async () => {
    const { db, port } = sqlite();
    accepted(db, 'audit_campaign_events', { id: 'c-1', at: '2026-10-05T00:00:00Z' });
    const store = new AuditReplicaStore(
      port,
      () => false,
      async () => '2026-10-01T00:00:00Z',
    );
    await new AuditWindowManager(store, fakeStreams().streams, () => NOW).refresh(CAMPAIGN, {
      privateStore: false,
    });
    const restarted = new AuditWindowManager(
      store,
      synced(fakeStreams().streams, new Set()),
      () => NOW,
    );
    expect(await restarted.acknowledgements(CAMPAIGN)).toEqual([]);
  });
});
