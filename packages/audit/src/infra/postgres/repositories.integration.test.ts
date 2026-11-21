import { afterAll, describe, expect, test } from 'bun:test';
import type { AuditEvent } from '@rpg/contracts';
import { sql } from 'drizzle-orm';
import { deriveAuditEventId } from '../../model.ts';
import { type AuditDiagnostics, DurableAuditRecorder } from '../../recorder.ts';
import { AuditRendererRegistry } from '../../renderers.ts';
import {
  AccountAuditRepository,
  CampaignAuditRepository,
  connectAuditDatabase,
  PostgresAuditRepairOutbox,
  PrivateAuditRepository,
} from './repositories.ts';

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
/** One connection, so a session temp table stands in for a domain table. */
const single =
  connection === undefined || databaseUrl === undefined
    ? undefined
    : connectAuditDatabase(databaseUrl, { max: 1 });

afterAll(async () => {
  await connection?.close();
  await single?.close();
});

function codeOf(error: unknown): string | undefined {
  let current: unknown = error;
  while (typeof current === 'object' && current !== null) {
    if ('code' in current && typeof current.code === 'string') return current.code;
    current = 'cause' in current ? current.cause : undefined;
  }
  return undefined;
}

async function failureCode(work: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await work();
  } catch (error) {
    return codeOf(error);
  }
  return 'no_error';
}

describe.skipIf(connection === undefined)('PostgreSQL audit stores', () => {
  const db = () => {
    if (connection === undefined) throw new Error('database unavailable');
    return connection.db;
  };
  const signals: unknown[] = [];
  const diagnostics: AuditDiagnostics = {
    degraded: (signal) => signals.push(signal),
    deadLettered: (signal) => signals.push(signal),
    repaired: (signal) => signals.push(signal),
  };
  const recorderFor = (database = db()) =>
    new DurableAuditRecorder({
      campaign: new CampaignAuditRepository(database),
      private: new PrivateAuditRepository(database),
      account: new AccountAuditRepository(database),
      outbox: new PostgresAuditRepairOutbox(database),
      registry: new AuditRendererRegistry(),
      diagnostics,
    });

  function event(campaignId: string, overrides: Partial<Omit<AuditEvent, 'id'>> = {}) {
    const userId = crypto.randomUUID();
    return {
      campaignId,
      actor: { userId, campaignId, role: 'gm' as const },
      action: 'resource.changed',
      targetType: 'character_resource',
      targetId: crypto.randomUUID(),
      before: { value: 6 },
      after: { value: 2 },
      at: '2026-10-24T12:00:00.000Z',
      private: false,
      ...overrides,
    };
  }

  async function count(table: string, campaignId: string): Promise<number> {
    const rows = (await db().execute(
      sql`select count(*)::int as n from ${sql.identifier(table)} where campaign_id = ${campaignId}`,
    )) as unknown as { n: number }[];
    return rows[0]?.n ?? 0;
  }

  test('each event exists in exactly one physical table, with independent sequences', async () => {
    const campaignId = crypto.randomUUID();
    const recorder = recorderFor();
    expect(await recorder.recordCampaign({ event: event(campaignId) })).toBe('recorded');
    expect(await recorder.recordCampaign({ event: event(campaignId, { private: true }) })).toBe(
      'recorded',
    );
    expect(await recorder.recordCampaign({ event: event(campaignId, { private: true }) })).toBe(
      'recorded',
    );

    expect(await count('audit_campaign_events', campaignId)).toBe(1);
    expect(await count('audit_private_events', campaignId)).toBe(2);
    const campaign = await new CampaignAuditRepository(db()).listForCampaign(campaignId, {
      limit: 10,
    });
    const privateRows = await new PrivateAuditRepository(db()).listForCampaign(campaignId, {
      limit: 10,
    });
    // Private events never consume campaign sequence values (no gap side channel).
    expect(campaign.map((row) => row.campaignSequence)).toEqual([1]);
    expect(privateRows.map((row) => row.campaignSequence)).toEqual([2, 1]);
    expect(campaign[0]?.targetVisibility).toEqual({ visibility: { mode: 'gm_only' } });
  });

  test('retry and concurrent resubmission by origin mutation ID store one event', async () => {
    const campaignId = crypto.randomUUID();
    const origin = crypto.randomUUID();
    const recorder = recorderFor();
    const outcomes = await Promise.all(
      Array.from({ length: 6 }, () =>
        recorder.recordCampaign({ event: event(campaignId), originMutationId: origin }),
      ),
    );
    expect(outcomes.filter((outcome) => outcome === 'recorded')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === 'duplicate')).toHaveLength(5);
    const rows = await new CampaignAuditRepository(db()).listForCampaign(campaignId, { limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(deriveAuditEventId(origin));
    expect(rows[0]?.originMutationId).toBe(origin);
  });

  test('concurrent appends get unique contiguous order independent of client clocks', async () => {
    const campaignId = crypto.randomUUID();
    const recorder = recorderFor();
    // Later-accepted event claims an earlier client time: authority order must not follow it.
    await recorder.recordCampaign({ event: event(campaignId, { at: '2030-01-01T00:00:00.000Z' }) });
    await recorder.recordCampaign({ event: event(campaignId, { at: '2000-01-01T00:00:00.000Z' }) });
    await Promise.all(
      Array.from({ length: 12 }, () => recorder.recordCampaign({ event: event(campaignId) })),
    );

    const rows = await new CampaignAuditRepository(db()).listForCampaign(campaignId, { limit: 50 });
    expect(rows.map((row) => row.campaignSequence)).toEqual(
      Array.from({ length: 14 }, (_value, index) => 14 - index),
    );
    const first = rows.find((row) => row.campaignSequence === 1);
    const second = rows.find((row) => row.campaignSequence === 2);
    expect(first?.clientRecordedAt.toISOString()).toBe('2030-01-01T00:00:00.000Z');
    expect(second?.clientRecordedAt.toISOString()).toBe('2000-01-01T00:00:00.000Z');
    const page = await new CampaignAuditRepository(db()).listForCampaign(campaignId, {
      limit: 3,
      beforeSequence: 5,
    });
    expect(page.map((row) => row.campaignSequence)).toEqual([4, 3, 2]);
  });

  test('history cannot be updated, deleted, or truncated', async () => {
    const campaignId = crypto.randomUUID();
    await recorderFor().recordCampaign({ event: event(campaignId) });
    await recorderFor().recordCampaign({ event: event(campaignId, { private: true }) });

    for (const table of ['audit_campaign_events', 'audit_private_events']) {
      const name = sql.identifier(table);
      // Table owner: the guard trigger rejects.
      expect(
        await failureCode(() =>
          db().execute(sql`update ${name} set action = 'forged' where campaign_id = ${campaignId}`),
        ),
      ).toBe('42501');
      expect(
        await failureCode(() =>
          db().execute(sql`delete from ${name} where campaign_id = ${campaignId}`),
        ),
      ).toBe('42501');
      expect(await failureCode(() => db().execute(sql`truncate ${name}`))).toBe('42501');
      // Application role: no UPDATE/DELETE privilege at all.
      for (const statement of [
        sql`update ${name} set action = 'forged' where campaign_id = ${campaignId}`,
        sql`delete from ${name} where campaign_id = ${campaignId}`,
      ]) {
        expect(
          await failureCode(() =>
            db().transaction(async (transaction) => {
              await transaction.execute(sql`set local role rpg_audit_writer`);
              await transaction.execute(statement);
            }),
          ),
        ).toBe('42501');
      }
      // Maintenance role with the retention flag still cannot delete recent history.
      expect(
        await failureCode(() =>
          db().transaction(async (transaction) => {
            await transaction.execute(sql`set local role rpg_audit_maintenance`);
            await transaction.execute(sql`set local rpg.audit_retention = 'on'`);
            await transaction.execute(sql`delete from ${name} where campaign_id = ${campaignId}`);
          }),
        ),
      ).toBe('42501');
    }
    expect(await count('audit_campaign_events', campaignId)).toBe(1);
    expect(await count('audit_private_events', campaignId)).toBe(1);

    expect(
      await failureCode(() =>
        db().execute(
          sql`update audit_campaign_sequences set last_sequence = 0 where campaign_id = ${campaignId}`,
        ),
      ),
    ).toBe('42501');
  });

  test('the application role can append through every store', async () => {
    const campaignId = crypto.randomUUID();
    const tokenId = crypto.randomUUID();
    const recorder = recorderFor();
    const outcomes = await db().transaction(async (transaction) => {
      await transaction.execute(sql`set local role rpg_audit_writer`);
      return [
        await recorder.recordWithin(transaction, { event: event(campaignId) }),
        await recorder.recordWithin(transaction, { event: event(campaignId, { private: true }) }),
        await new AccountAuditRepository(db()).appendWithin(transaction, {
          store: 'account',
          eventId: deriveAuditEventId(tokenId),
          originMutationId: tokenId,
          rendererVersion: 0,
          event: {
            subjectUserId: crypto.randomUUID(),
            actor: { kind: 'operator', reference: 'host:test' },
            action: 'recovery.issued',
            targetType: 'recovery_token',
            targetId: tokenId,
            at: '2026-10-24T12:00:00.000Z',
          },
        }),
      ];
    });
    expect(outcomes.slice(0, 2)).toEqual(['recorded', 'recorded']);
    expect(outcomes[2]).toMatchObject({ status: 'inserted' });
  });

  test('in-transaction audit commits and rolls back with the domain write', async () => {
    const committed = crypto.randomUUID();
    const rejected = crypto.randomUUID();
    const recorder = recorderFor();
    await db().transaction(async (transaction) => {
      expect(await recorder.recordWithin(transaction, { event: event(committed) })).toBe(
        'recorded',
      );
    });
    try {
      await db().transaction(async (transaction) => {
        await recorder.recordWithin(transaction, { event: event(rejected) });
        throw new Error('business rejection');
      });
    } catch {
      // The mutation was rejected; its audit insert must roll back with it.
    }
    expect(await count('audit_campaign_events', committed)).toBe(1);
    expect(await count('audit_campaign_events', rejected)).toBe(0);
  });

  test('an audit insert failure inside the domain transaction never aborts it', async () => {
    if (single === undefined) throw new Error('database unavailable');
    const campaignId = crypto.randomUUID();
    const origin = crypto.randomUUID();
    // Occupy sequence 1 without an allocator row, so the real insert hits a unique violation.
    await single.db.execute(sql`
      insert into audit_campaign_events (
        id, campaign_id, campaign_sequence, actor_user_id, actor_role, action, target_type,
        target_id, target_visibility, client_recorded_at, origin_mutation_id, renderer_version
      ) values (
        ${crypto.randomUUID()}, ${campaignId}, 1, ${crypto.randomUUID()}, 'gm', 'seed', 'seed',
        ${crypto.randomUUID()}, '{"visibility":{"mode":"gm_only"}}', now(), ${crypto.randomUUID()}, 0
      )`);
    await single.db.execute(sql`create temp table if not exists audit_domain_probe (id uuid)`);
    const probe = crypto.randomUUID();
    const recorder = recorderFor(single.db);

    const outcome = await single.db.transaction(async (transaction) => {
      await transaction.execute(sql`insert into audit_domain_probe values (${probe})`);
      const result = await recorder.recordWithin(transaction, {
        event: event(campaignId),
        originMutationId: origin,
      });
      await transaction.execute(sql`select 1`); // transaction is still usable
      return result;
    });

    expect(outcome).toBe('deferred');
    const domain = (await single.db.execute(
      sql`select count(*)::int as n from audit_domain_probe where id = ${probe}`,
    )) as unknown as { n: number }[];
    expect(domain[0]?.n).toBe(1);
    const parked = (await single.db.execute(sql`
      select state, failure_code, store, campaign_id from audit_repair_outbox
      where event_id = ${deriveAuditEventId(origin)}`)) as unknown as Record<string, unknown>[];
    expect(parked).toEqual([
      {
        state: 'pending',
        failure_code: 'store_unavailable',
        store: 'campaign',
        campaign_id: campaignId,
      },
    ]);
  });

  test('outbox retry repairs into one event and reports backlog', async () => {
    const campaignId = crypto.randomUUID();
    const origin = crypto.randomUUID();
    const outbox = new PostgresAuditRepairOutbox(db());
    const before = await outbox.backlog();
    const failing = new DurableAuditRecorder({
      campaign: {
        append: async () => {
          throw new Error('down');
        },
        appendWithin: async () => {
          throw new Error('down');
        },
      },
      private: new PrivateAuditRepository(db()),
      account: new AccountAuditRepository(db()),
      outbox,
      registry: new AuditRendererRegistry(),
      diagnostics,
      options: { baseDelayMs: 0 },
    });
    expect(
      await failing.recordCampaign({ event: event(campaignId), originMutationId: origin }),
    ).toBe('deferred');
    expect((await outbox.backlog()).pending).toBe(before.pending + 1);

    const healthy = recorderFor();
    const report = await healthy.retryPending(500);
    expect(report.outboxReadable).toBe(true);
    expect(report.repaired).toBeGreaterThanOrEqual(1);
    expect(await count('audit_campaign_events', campaignId)).toBe(1);
    await healthy.retryPending(500);
    expect(await count('audit_campaign_events', campaignId)).toBe(1);
    const [row] = (await db().execute(
      sql`select state from audit_repair_outbox where event_id = ${deriveAuditEventId(origin)}`,
    )) as unknown as { state: string }[];
    expect(row?.state).toBe('repaired');
  });

  test('account events are idempotent by origin and stay out of campaign stores', async () => {
    const tokenId = crypto.randomUUID();
    const subjectUserId = crypto.randomUUID();
    const recorder = recorderFor();
    const submission = {
      originMutationId: tokenId,
      event: {
        subjectUserId,
        actor: { kind: 'operator' as const, reference: 'host:desk-1' },
        action: 'recovery.issued',
        targetType: 'recovery_token',
        targetId: tokenId,
        after: { expiresAt: '2026-10-24T12:30:00.000Z' },
        at: '2026-10-24T12:00:00.000Z',
      },
    };
    expect(await recorder.recordAccount(submission)).toBe('recorded');
    expect(await recorder.recordAccount(submission)).toBe('duplicate');
    const rows = (await db().execute(sql`
      select actor_kind, actor_reference, action, after_value from audit_account_events
      where subject_user_id = ${subjectUserId}`)) as unknown as Record<string, unknown>[];
    expect(rows).toEqual([
      {
        actor_kind: 'operator',
        actor_reference: 'host:desk-1',
        action: 'recovery.issued',
        after_value: { expiresAt: '2026-10-24T12:30:00.000Z' },
      },
    ]);
  });
});
