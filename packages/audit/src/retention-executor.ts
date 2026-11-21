import { sql } from 'drizzle-orm';
import type { AuditDatabase } from './infra/postgres/repositories.ts';
import {
  auditAccountEvents,
  auditCampaignEvents,
  auditPrivateEvents,
} from './infra/postgres/schema.ts';
import type { AuditStoreName } from './model.ts';
import {
  type AuditRetentionPlan,
  type AuditRetentionReport,
  auditRetentionReport,
  type PostgresAuditRetentionReporter,
} from './retention.ts';

/**
 * Feature 06 retention follow-up: the deletion executor for the approved 365-day policy
 * (Approved 2026-10-28, delegated by owner).
 *
 * OFF by default: unless `delete: true` is passed explicitly, a run is the report-only pass and
 * no statement below is ever sent. When enabled it deletes only groups the plan left with no
 * blocker (watermark evidence present, every eligible replica acknowledged, no pending
 * reference), only rows past both the plan's boundary and the database's own 365-day check, and
 * for campaign stores never past the sequence the watermark decision covered. Each batch is its
 * own short transaction under `SET LOCAL ROLE rpg_audit_maintenance` with
 * `rpg.audit_retention = on`, the only combination the migration 0004 guard trigger admits; the
 * connecting role must be a member of `rpg_audit_maintenance`.
 */

export const AUDIT_RETENTION_DEFAULT_BATCH_SIZE = 500;
export const AUDIT_RETENTION_MAX_BATCH_SIZE = 5000;
export const AUDIT_RETENTION_DEFAULT_MAX_BATCHES = 100;

export interface AuditRetentionRunOptions {
  /** Deletion switch. Anything but `true` deletes nothing. */
  readonly delete?: boolean;
  /** Rows per transaction (1..5000, default 500). */
  readonly batchSize?: number;
  /** Batches per run across all groups (default 100); the next run continues. */
  readonly maxBatches?: number;
}

const TABLES = {
  campaign: auditCampaignEvents,
  private: auditPrivateEvents,
} as const;

export class PostgresAuditRetentionExecutor {
  constructor(
    private readonly db: AuditDatabase,
    private readonly reporter: Pick<PostgresAuditRetentionReporter, 'plan'>,
  ) {}

  async run(
    options: AuditRetentionRunOptions = {},
    now: Date = new Date(),
  ): Promise<AuditRetentionReport> {
    const plan = await this.reporter.plan(now);
    if (options.delete !== true) return auditRetentionReport(plan, { enabled: false });
    const batchSize = Math.max(
      1,
      Math.min(
        Math.trunc(options.batchSize ?? AUDIT_RETENTION_DEFAULT_BATCH_SIZE),
        AUDIT_RETENTION_MAX_BATCH_SIZE,
      ),
    );
    let budget = Math.max(1, Math.trunc(options.maxBatches ?? AUDIT_RETENTION_DEFAULT_MAX_BATCHES));
    const deleted: Partial<Record<AuditStoreName, number>> = {};
    let truncated = false;
    for (const target of deletable(plan)) {
      for (;;) {
        if (budget === 0) {
          truncated = true;
          break;
        }
        budget -= 1;
        const count = await this.#batch(plan.boundary, target, batchSize);
        deleted[target.store] = (deleted[target.store] ?? 0) + count;
        if (count < batchSize) break;
      }
      if (truncated) break;
    }
    return auditRetentionReport(plan, { enabled: true, deleted, truncated });
  }

  async #batch(boundary: Date, target: DeletableGroup, limit: number): Promise<number> {
    const before = boundary.toISOString();
    return this.db.transaction(async (transaction) => {
      await transaction.execute(sql`set local role rpg_audit_maintenance`);
      await transaction.execute(sql`select set_config('rpg.audit_retention', 'on', true)`);
      if (target.store === 'account') {
        const table = auditAccountEvents;
        const removed = (await transaction.execute(sql`
          delete from ${table} where ${table.id} in (
            select ${table.id} from ${table}
            where ${table.acceptedAt} < ${before}::timestamptz
              and ${table.acceptedAt} < now() - interval '365 days'
            order by ${table.accountSequence} limit ${limit})
          returning ${table.id}`)) as unknown as unknown[];
        return removed.length;
      }
      const table = TABLES[target.store];
      const removed = (await transaction.execute(sql`
        delete from ${table} where ${table.id} in (
          select ${table.id} from ${table}
          where ${table.campaignId} = ${target.campaignId}
            and ${table.campaignSequence} <= ${target.throughSequence}
            and ${table.acceptedAt} < ${before}::timestamptz
            and ${table.acceptedAt} < now() - interval '365 days'
          order by ${table.campaignSequence} limit ${limit})
        returning ${table.id}`)) as unknown as unknown[];
      return removed.length;
    });
  }
}

type DeletableGroup =
  | { readonly store: 'account' }
  | {
      readonly store: 'campaign' | 'private';
      readonly campaignId: string;
      readonly throughSequence: number;
    };

/** Only groups with no blocker; a campaign group also needs the sequence its decision covered. */
function deletable(plan: AuditRetentionPlan): DeletableGroup[] {
  const groups: DeletableGroup[] = [];
  for (const { store, groups: planned } of plan.stores) {
    for (const group of planned) {
      if (group.blockers.length > 0 || group.eligibleRows === 0) continue;
      if (store === 'account') groups.push({ store });
      else if (group.campaignId !== null && group.throughSequence !== null) {
        groups.push({
          store,
          campaignId: group.campaignId,
          throughSequence: group.throughSequence,
        });
      }
    }
  }
  return groups;
}
