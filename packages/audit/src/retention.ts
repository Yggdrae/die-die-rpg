import type { TombstonePurgeBlocker, TombstonePurgeEvidence } from '@rpg/contracts';
import { sql } from 'drizzle-orm';
import type { AuditDatabase } from './infra/postgres/repositories.ts';
import {
  auditAccountEvents,
  auditCampaignEvents,
  auditPrivateEvents,
} from './infra/postgres/schema.ts';
import type { AuditStoreName } from './model.ts';

/**
 * Feature 06 task 06: server retention, the REPORT side (SELECT only).
 *
 * `_db.md`: audit rows older than 365 days from `accepted_at` are deleted per table, only after
 * every eligible sync subscriber acknowledged a cursor beyond them. The 365-day policy is
 * Approved (2026-10-28, delegated by owner). This module only plans: it names the rows past the
 * window per store and campaign and what still blocks them. It holds no DELETE path; deletion is
 * `PostgresAuditRetentionExecutor` (`retention-executor.ts`), off unless an operator enables it,
 * and the database admits it only from `rpg_audit_maintenance` with `rpg.audit_retention = on`
 * (migration 0004).
 */

export const AUDIT_RETENTION_DAYS = 365;

/** Why an eligible group may not be deleted yet. An empty list means deletable when enabled. */
export type AuditRetentionBlocker = TombstonePurgeBlocker | 'no_watermark_evidence';

export interface AuditRetentionGroup {
  /** `null` for the account store (no campaign). */
  readonly campaignId: string | null;
  readonly eligibleRows: number;
  readonly oldestAcceptedAt: string;
  readonly newestEligibleAcceptedAt: string;
  readonly blockers: readonly AuditRetentionBlocker[];
}

export interface AuditRetentionStoreReport {
  readonly store: AuditStoreName;
  readonly eligibleRows: number;
  readonly groups: readonly AuditRetentionGroup[];
  /** Rows this run deleted from the store (always 0 in report-only mode). */
  readonly deleted: number;
}

export interface AuditRetentionReport {
  /** `report_only` unless an operator enabled deletion for this run. */
  readonly mode: 'report_only' | 'delete';
  /** The 365-day policy: Approved (2026-10-28, delegated by owner). */
  readonly deletionApproved: true;
  readonly deletionEnabled: boolean;
  readonly retentionDays: number;
  readonly generatedAt: string;
  /** Rows accepted before this instant are past the window. */
  readonly boundary: string;
  readonly stores: readonly AuditRetentionStoreReport[];
  /** Rows deleted by this run (0 in report-only mode). */
  readonly deleted: number;
  /** Deletion stopped at its batch bound; the next run continues. */
  readonly truncated: boolean;
}

/** A group as planned: what the report shows plus the newest sequence the decision covered. */
export interface AuditRetentionPlannedGroup extends AuditRetentionGroup {
  /** Campaign stores: the newest eligible `campaign_sequence`; deletion never goes past it. */
  readonly throughSequence: number | null;
}

export interface AuditRetentionPlan {
  readonly now: Date;
  readonly boundary: Date;
  readonly stores: readonly {
    readonly store: AuditStoreName;
    readonly groups: readonly AuditRetentionPlannedGroup[];
  }[];
}

interface GroupRow {
  readonly campaign_id: string | null;
  readonly eligible: string | number;
  readonly oldest: string | Date;
  readonly newest: string | Date;
  readonly max_sequence: string | number | null;
  readonly newest_id: string;
}

export const AUDIT_RETENTION_STORES = [
  { store: 'campaign', table: auditCampaignEvents, scope: 'audit_campaign_events' },
  { store: 'private', table: auditPrivateEvents, scope: 'audit_private_events' },
] as const;

export function auditRetentionBoundary(now: Date): Date {
  return new Date(now.getTime() - AUDIT_RETENTION_DAYS * 86_400_000);
}

export class PostgresAuditRetentionReporter {
  constructor(
    private readonly db: AuditDatabase,
    /**
     * Feature 03 watermark evidence (`TombstonePurgeEvidence`), asked per campaign and store with
     * the newest eligible row as the cursor. Absent: every campaign group reports
     * `no_watermark_evidence`.
     */
    private readonly watermarks?: Pick<TombstonePurgeEvidence, 'decide'>,
  ) {}

  async report(now: Date = new Date()): Promise<AuditRetentionReport> {
    return auditRetentionReport(await this.plan(now), { enabled: false });
  }

  /** Eligible groups and their blockers; SELECT only. */
  async plan(now: Date = new Date()): Promise<AuditRetentionPlan> {
    const boundary = auditRetentionBoundary(now);
    const stores: AuditRetentionPlan['stores'][number][] = [];
    for (const { store, table, scope } of AUDIT_RETENTION_STORES) {
      const rows = (await this.db.execute(sql`
        select campaign_id, count(*) as eligible, min(accepted_at) as oldest,
               max(accepted_at) as newest, max(campaign_sequence) as max_sequence,
               (array_agg(id order by campaign_sequence desc))[1] as newest_id
        from ${table} where accepted_at < ${boundary.toISOString()}::timestamptz
        group by campaign_id order by campaign_id`)) as unknown as GroupRow[];
      const groups: AuditRetentionPlannedGroup[] = [];
      for (const row of rows) {
        groups.push({
          campaignId: row.campaign_id,
          eligibleRows: Number(row.eligible),
          oldestAcceptedAt: iso(row.oldest),
          newestEligibleAcceptedAt: iso(row.newest),
          blockers: await this.#watermark(row, scope, now),
          throughSequence: row.max_sequence === null ? null : Number(row.max_sequence),
        });
      }
      stores.push({ store, groups });
    }
    const account = (await this.db.execute(sql`
      select null as campaign_id, count(*) as eligible, min(accepted_at) as oldest,
             max(accepted_at) as newest, null as max_sequence, null as newest_id
      from ${auditAccountEvents} where accepted_at < ${boundary.toISOString()}::timestamptz
      having count(*) > 0`)) as unknown as GroupRow[];
    stores.push({
      store: 'account',
      groups: account.map((row) => ({
        campaignId: null,
        eligibleRows: Number(row.eligible),
        oldestAcceptedAt: iso(row.oldest),
        newestEligibleAcceptedAt: iso(row.newest),
        // Never replicated (approved account-store note): no watermark holds account rows.
        blockers: [],
        throughSequence: null,
      })),
    });
    return { now, boundary, stores };
  }

  async #watermark(row: GroupRow, scope: string, now: Date): Promise<AuditRetentionBlocker[]> {
    if (this.watermarks === undefined || row.campaign_id === null) return ['no_watermark_evidence'];
    try {
      const decision = await this.watermarks.decide(
        {
          campaignId: row.campaign_id,
          scope,
          recordId: row.newest_id,
          sequence: Number(row.max_sequence ?? 0),
          deletedAt: iso(row.newest),
        },
        now,
      );
      return decision.safe ? [] : [...decision.blockers];
    } catch {
      return ['no_watermark_evidence'];
    }
  }
}

/** The operator report of a plan, with the rows a run deleted per store (none by default). */
export function auditRetentionReport(
  plan: AuditRetentionPlan,
  run: {
    readonly enabled: boolean;
    readonly deleted?: Readonly<Partial<Record<AuditStoreName, number>>>;
    readonly truncated?: boolean;
  },
): AuditRetentionReport {
  const stores = plan.stores.map(({ store, groups }) => ({
    store,
    eligibleRows: groups.reduce((total, group) => total + group.eligibleRows, 0),
    groups: groups.map(({ throughSequence: _covered, ...group }) => group),
    deleted: run.deleted?.[store] ?? 0,
  }));
  return {
    mode: run.enabled ? 'delete' : 'report_only',
    deletionApproved: true,
    deletionEnabled: run.enabled,
    retentionDays: AUDIT_RETENTION_DAYS,
    generatedAt: plan.now.toISOString(),
    boundary: plan.boundary.toISOString(),
    stores,
    deleted: stores.reduce((total, store) => total + store.deleted, 0),
    truncated: run.truncated ?? false,
  };
}

function iso(value: string | Date): string {
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(
    String(value)
      .replace(' ', 'T')
      .replace(/([+-]\d\d)$/, '$1:00'),
  );
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}
