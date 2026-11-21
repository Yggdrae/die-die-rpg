import { afterAll, describe, expect, test } from 'bun:test';
import type { TombstonePurgeDecision, TombstoneRef } from '@rpg/contracts';
import { sql } from 'drizzle-orm';
import {
  AUDIT_RETENTION_DAYS,
  type AuditRetentionPlan,
  PostgresAuditRetentionReporter,
} from '../../retention.ts';
import { PostgresAuditRetentionExecutor } from '../../retention-executor.ts';
import { type AuditDatabase, connectAuditDatabase } from './repositories.ts';

/**
 * Feature 06 server retention (365 days, Approved 2026-10-28, delegated by owner).
 *
 * The reporter names eligible rows per store and campaign and asks feature 03 watermark evidence
 * what still blocks them; it deletes nothing. The executor deletes nothing unless `delete: true`,
 * then only unblocked groups, in bounded batches, under the maintenance role. The database
 * rejects any other delete.
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

const DAY = 86_400_000;
/** Account rows this suite fabricates; any other old account row is real data and stays. */
const PROBE = 'retention-probe';

function codeOf(error: unknown): string | undefined {
  let current: unknown = error;
  while (typeof current === 'object' && current !== null) {
    if ('code' in current && typeof current.code === 'string') return current.code;
    current = 'cause' in current ? current.cause : undefined;
  }
  return undefined;
}

type Table = 'audit_campaign_events' | 'audit_private_events';

async function insert(
  db: AuditDatabase,
  table: Table,
  campaign: string,
  sequence: number,
  at: Date,
): Promise<string> {
  const id = crypto.randomUUID();
  await db.execute(
    sql`insert into ${sql.raw(table)} (id, campaign_id, campaign_sequence, actor_user_id,
          actor_role, action, target_type, target_id, target_visibility, client_recorded_at,
          accepted_at, origin_mutation_id, renderer_version)
        values (${id}, ${campaign}, ${sequence}, ${crypto.randomUUID()}, 'owner',
          'campaign.details_updated', 'campaign', ${campaign},
          '{"visibility":{"mode":"everyone"}}'::jsonb, ${at.toISOString()}::timestamptz,
          ${at.toISOString()}::timestamptz, ${crypto.randomUUID()}, 1)`,
  );
  return id;
}

async function insertAccount(db: AuditDatabase, subject: string, at: Date): Promise<void> {
  await db.execute(
    sql`insert into audit_account_events (id, subject_user_id, actor_kind, actor_reference,
          action, target_type, target_id, client_recorded_at, accepted_at, origin_mutation_id,
          renderer_version)
        values (${crypto.randomUUID()}, ${subject}, 'operator', ${PROBE}, 'recovery.issued',
          'recovery_token', ${crypto.randomUUID()}, ${at.toISOString()}::timestamptz,
          ${at.toISOString()}::timestamptz, ${crypto.randomUUID()}, 0)`,
  );
}

async function count(db: AuditDatabase, table: Table, campaign: string): Promise<number> {
  const [row] = (await db.execute(
    sql`select count(*) as total from ${sql.raw(table)} where campaign_id = ${campaign}`,
  )) as unknown as { total: string }[];
  return Number(row?.total ?? 0);
}

async function accountCount(db: AuditDatabase, subject: string): Promise<number> {
  const [row] = (await db.execute(
    sql`select count(*) as total from audit_account_events where subject_user_id = ${subject}`,
  )) as unknown as { total: string }[];
  return Number(row?.total ?? 0);
}

/** Every old account row is one this suite fabricated (so deleting them touches no real data). */
async function onlyProbeAccountRowsAreOld(db: AuditDatabase): Promise<boolean> {
  const [row] = (await db.execute(
    sql`select count(*) as total from audit_account_events
        where accepted_at < now() - interval '365 days'
          and actor_reference is distinct from ${PROBE}`,
  )) as unknown as { total: string }[];
  return Number(row?.total ?? 0) === 0;
}

/**
 * Restricts a real plan to this test's campaigns (and, when safe, the probe account rows), so an
 * enabled run never touches rows other suites left in the shared dev database.
 */
function scopedTo(
  reporter: PostgresAuditRetentionReporter,
  campaigns: ReadonlySet<string>,
  account: boolean,
) {
  return {
    plan: async (now?: Date): Promise<AuditRetentionPlan> => {
      const plan = await reporter.plan(now);
      return {
        ...plan,
        stores: plan.stores.map(({ store, groups }) => ({
          store,
          groups: groups.filter((group) =>
            group.campaignId === null ? account : campaigns.has(group.campaignId),
          ),
        })),
      };
    },
  };
}

describe.skipIf(connection === undefined)('audit retention (PostgreSQL)', () => {
  test('report names rows past 365 days with their blockers and deletes none', async () => {
    if (connection === undefined) throw new Error('database unavailable');
    const { db } = connection;
    const now = new Date();
    const campaign = crypto.randomUUID();
    const old = new Date(now.getTime() - (AUDIT_RETENTION_DAYS + 35) * DAY);
    const older = new Date(now.getTime() - (AUDIT_RETENTION_DAYS + 70) * DAY);
    const recent = new Date(now.getTime() - 100 * DAY);
    const oldest = await insert(db, 'audit_campaign_events', campaign, 1, older);
    const newestEligible = await insert(db, 'audit_campaign_events', campaign, 2, old);
    await insert(db, 'audit_campaign_events', campaign, 3, recent);
    await insert(db, 'audit_private_events', campaign, 1, old);
    const subject = crypto.randomUUID();
    await insertAccount(db, subject, old);
    const total = async () =>
      (await count(db, 'audit_campaign_events', campaign)) +
      (await count(db, 'audit_private_events', campaign)) +
      (await accountCount(db, subject));
    expect(await total()).toBe(5);

    const asked: TombstoneRef[] = [];
    const report = await new PostgresAuditRetentionReporter(db, {
      decide: async (tombstone) => {
        asked.push(tombstone);
        return tombstone.scope === 'audit_campaign_events'
          ? { safe: false, blockers: ['unacknowledged_replica'] }
          : { safe: true };
      },
    }).report(now);

    expect(report).toMatchObject({
      mode: 'report_only',
      deletionApproved: true,
      deletionEnabled: false,
      retentionDays: 365,
      deleted: 0,
      truncated: false,
    });
    expect(report.boundary).toBe(new Date(now.getTime() - 365 * DAY).toISOString());
    const group = (store: string) =>
      report.stores
        .find((item) => item.store === store)
        ?.groups.find((item) => item.campaignId === campaign);
    expect(group('campaign')).toEqual({
      campaignId: campaign,
      eligibleRows: 2,
      oldestAcceptedAt: older.toISOString(),
      newestEligibleAcceptedAt: old.toISOString(),
      blockers: ['unacknowledged_replica'],
    });
    // Watermarks release the private group, but report-only still deletes nothing.
    expect(group('private')?.blockers).toEqual([]);
    expect(group('private')?.eligibleRows).toBe(1);
    const account = report.stores.find((item) => item.store === 'account');
    expect(account?.eligibleRows).toBeGreaterThanOrEqual(1);
    // Account rows are never replicated: no watermark holds them.
    expect(account?.groups.every((item) => item.blockers.length === 0)).toBe(true);
    // The watermark question names the newest eligible event and its sequence, per store.
    expect(
      asked.find((item) => item.campaignId === campaign && item.scope === 'audit_campaign_events'),
    ).toEqual({
      campaignId: campaign,
      scope: 'audit_campaign_events',
      recordId: newestEligible,
      sequence: 2,
      deletedAt: old.toISOString(),
    });
    expect(await total()).toBe(5);
    expect(oldest).not.toBe(newestEligible);

    // Without watermark evidence nothing is assumed safe.
    const blind = await new PostgresAuditRetentionReporter(db).report(now);
    expect(
      blind.stores
        .find((item) => item.store === 'campaign')
        ?.groups.find((item) => item.campaignId === campaign)?.blockers,
    ).toEqual(['no_watermark_evidence']);

    // Application code cannot delete: the guard rejects it (append-only triggers, 0004).
    let code: string | undefined;
    try {
      await db.execute(sql`delete from audit_campaign_events where id = ${oldest}`);
    } catch (error) {
      code = codeOf(error);
    }
    expect(code).toBe('42501');
    expect(await total()).toBe(5);
  });

  test('the executor deletes nothing by default, even when every group is unblocked', async () => {
    if (connection === undefined) throw new Error('database unavailable');
    const { db } = connection;
    const now = new Date();
    const campaign = crypto.randomUUID();
    const old = new Date(now.getTime() - (AUDIT_RETENTION_DAYS + 10) * DAY);
    await insert(db, 'audit_campaign_events', campaign, 1, old);
    await insert(db, 'audit_private_events', campaign, 1, old);
    const reporter = new PostgresAuditRetentionReporter(db, {
      decide: async () => ({ safe: true }),
    });
    const executor = new PostgresAuditRetentionExecutor(
      db,
      scopedTo(reporter, new Set([campaign]), true),
    );
    for (const options of [undefined, {}, { delete: false }]) {
      const report = await executor.run(options, now);
      expect(report.mode).toBe('report_only');
      expect(report.deletionEnabled).toBe(false);
      expect(report.deleted).toBe(0);
    }
    expect(await count(db, 'audit_campaign_events', campaign)).toBe(1);
    expect(await count(db, 'audit_private_events', campaign)).toBe(1);
  });

  test('enabled, it deletes only unblocked rows past 365 days, in bounded batches', async () => {
    if (connection === undefined) throw new Error('database unavailable');
    const { db } = connection;
    const now = new Date();
    const at = (days: number) => new Date(now.getTime() - days * DAY);
    const released = crypto.randomUUID();
    const unacknowledged = crypto.randomUUID();
    const pending = crypto.randomUUID();
    const unproven = crypto.randomUUID();
    // Released campaign: five old rows, one just inside the window, one recent.
    for (let sequence = 1; sequence <= 5; sequence += 1) {
      await insert(db, 'audit_campaign_events', released, sequence, at(AUDIT_RETENTION_DAYS + 50));
    }
    await insert(db, 'audit_campaign_events', released, 6, at(AUDIT_RETENTION_DAYS - 1));
    await insert(db, 'audit_campaign_events', released, 7, at(3));
    await insert(db, 'audit_private_events', released, 1, at(AUDIT_RETENTION_DAYS + 20));
    for (const campaign of [unacknowledged, pending, unproven]) {
      await insert(db, 'audit_campaign_events', campaign, 1, at(AUDIT_RETENTION_DAYS + 40));
      await insert(db, 'audit_private_events', campaign, 1, at(AUDIT_RETENTION_DAYS + 40));
    }
    const subject = crypto.randomUUID();
    await insertAccount(db, subject, at(AUDIT_RETENTION_DAYS + 5));
    await insertAccount(db, subject, at(30));
    const decisions: Record<string, TombstonePurgeDecision> = {
      [released]: { safe: true },
      [unacknowledged]: { safe: false, blockers: ['unacknowledged_replica'] },
      [pending]: { safe: false, blockers: ['pending_mutation_reference'] },
    };
    const reporter = new PostgresAuditRetentionReporter(db, {
      decide: async (tombstone) => {
        const decision = decisions[tombstone.campaignId];
        // No answer for `unproven`: the evidence fails, so the group stays held.
        if (decision === undefined) throw new Error('evidence unavailable');
        return decision;
      },
    });
    const account = await onlyProbeAccountRowsAreOld(db);
    const executor = new PostgresAuditRetentionExecutor(
      db,
      scopedTo(reporter, new Set([released, unacknowledged, pending, unproven]), account),
    );

    // One batch of two: bounded, reported as truncated, the rest stays for the next run.
    const first = await executor.run({ delete: true, batchSize: 2, maxBatches: 1 }, now);
    expect(first).toMatchObject({ mode: 'delete', deletionEnabled: true, deleted: 2 });
    expect(first.truncated).toBe(true);
    expect(await count(db, 'audit_campaign_events', released)).toBe(5);

    const second = await executor.run({ delete: true, batchSize: 2 }, now);
    expect(second.truncated).toBe(false);
    const deletedFrom = (store: string) =>
      second.stores.find((item) => item.store === store)?.deleted;
    expect(deletedFrom('campaign')).toBe(3);
    expect(deletedFrom('private')).toBe(1);
    // Inside the window and recent rows stay; so does every row of a held group.
    expect(await count(db, 'audit_campaign_events', released)).toBe(2);
    expect(await count(db, 'audit_private_events', released)).toBe(0);
    for (const campaign of [unacknowledged, pending, unproven]) {
      expect(await count(db, 'audit_campaign_events', campaign)).toBe(1);
      expect(await count(db, 'audit_private_events', campaign)).toBe(1);
    }
    const blockersOf = (campaign: string) =>
      second.stores
        .find((item) => item.store === 'campaign')
        ?.groups.find((item) => item.campaignId === campaign)?.blockers;
    expect(blockersOf(unacknowledged)).toEqual(['unacknowledged_replica']);
    expect(blockersOf(pending)).toEqual(['pending_mutation_reference']);
    expect(blockersOf(unproven)).toEqual(['no_watermark_evidence']);
    if (account) {
      expect(deletedFrom('account')).toBeGreaterThanOrEqual(1);
      // The 30-day account row stays.
      expect(await accountCount(db, subject)).toBe(1);
    }

    // A second pass finds nothing more to delete.
    const third = await executor.run({ delete: true, batchSize: 2 }, now);
    expect(third.deleted).toBe(0);

    // The maintenance path still refuses a row inside the window (trigger re-checks 365 days).
    const [young] = (await db.execute(
      sql`select id from audit_campaign_events where campaign_id = ${released}
          order by campaign_sequence limit 1`,
    )) as unknown as { id: string }[];
    let code: string | undefined;
    try {
      await db.transaction(async (transaction) => {
        await transaction.execute(sql`set local role rpg_audit_maintenance`);
        await transaction.execute(sql`select set_config('rpg.audit_retention', 'on', true)`);
        await transaction.execute(sql`delete from audit_campaign_events where id = ${young?.id}`);
      });
    } catch (error) {
      code = codeOf(error);
    }
    expect(code).toBe('42501');
    // Without the setting, even the maintenance role cannot delete an old row.
    const [held] = (await db.execute(
      sql`select id from audit_campaign_events where campaign_id = ${unacknowledged} limit 1`,
    )) as unknown as { id: string }[];
    code = undefined;
    try {
      await db.transaction(async (transaction) => {
        await transaction.execute(sql`set local role rpg_audit_maintenance`);
        await transaction.execute(sql`delete from audit_campaign_events where id = ${held?.id}`);
      });
    } catch (error) {
      code = codeOf(error);
    }
    expect(code).toBe('42501');
    expect(await count(db, 'audit_campaign_events', released)).toBe(2);
    expect(await count(db, 'audit_campaign_events', unacknowledged)).toBe(1);
  });

  test('deletion never goes past the sequence the watermark decision covered', async () => {
    if (connection === undefined) throw new Error('database unavailable');
    const { db } = connection;
    const now = new Date();
    const campaign = crypto.randomUUID();
    for (let sequence = 1; sequence <= 3; sequence += 1) {
      await insert(
        db,
        'audit_campaign_events',
        campaign,
        sequence,
        new Date(now.getTime() - (AUDIT_RETENTION_DAYS + 9) * DAY),
      );
    }
    const reporter = new PostgresAuditRetentionReporter(db, {
      decide: async () => ({ safe: true }),
    });
    // The decision covered sequence 2 only (a row past it is not proven acknowledged).
    const executor = new PostgresAuditRetentionExecutor(db, {
      plan: async (at?: Date) => {
        const plan = await scopedTo(reporter, new Set([campaign]), false).plan(at);
        return {
          ...plan,
          stores: plan.stores.map(({ store, groups }) => ({
            store,
            groups: groups.map((group) => ({ ...group, throughSequence: 2 })),
          })),
        };
      },
    });
    const report = await executor.run({ delete: true }, now);
    expect(report.deleted).toBe(2);
    const [left] = (await db.execute(
      sql`select campaign_sequence as sequence from audit_campaign_events
          where campaign_id = ${campaign}`,
    )) as unknown as { sequence: string }[];
    expect(Number(left?.sequence)).toBe(3);
  });

  test('the report module has no delete statement', async () => {
    const source = (await Bun.file(new URL('../../retention.ts', import.meta.url)).text())
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    expect(source).not.toMatch(/delete\s+from|truncate\s|set_config|audit_retention\s*=/i);
  });
});
