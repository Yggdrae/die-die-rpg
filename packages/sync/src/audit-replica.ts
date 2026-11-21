import { isValidMutationAudit, type MutationAuditPayload } from './schemas.ts';

/**
 * Feature 06 task 04: the local side of audit replication (browser replica; pure logic and SQL
 * over the same small database port as `BrowserReplicaStore`, so it is testable under Bun).
 *
 * - Both audit stores replicate through their own streams (`campaign_audit`, `gm_private_audit`),
 *   windowed by explicit subscriptions per (campaign, accepted UTC month). The private stream is
 *   subscribed, and its table exists locally, only while the user holds a GM role.
 * - Compaction (`planAuditWindow`): the newest 90 days are always kept; older months are kept
 *   newest first while the campaign's two stores together stay within feature 06's 10 MB
 *   allocation; a month that does not fit is evicted with everything older, by unsubscribing it,
 *   so the provider removes its rows. Pending (unaccepted) events live in the mutation queue,
 *   never in these tables, so compaction cannot evict them; it never copies rows between stores.
 * - Reads (`AuditReplicaStore.read`) merge pending local events (queue order, labeled) above
 *   authority-accepted rows (acceptance time, newest first) and report partial local history.
 */

export const AUDIT_CAMPAIGN_STREAM = 'campaign_audit';
export const AUDIT_PRIVATE_STREAM = 'gm_private_audit';
export const AUDIT_CAMPAIGN_TABLE = 'audit_campaign_events';
export const AUDIT_PRIVATE_TABLE = 'audit_private_events';

/** Feature 06 `_db.md`: the campaign's two local audit stores share 10 MB. */
export const AUDIT_LOCAL_BUDGET_BYTES = 10 * 1024 * 1024;
/** Feature 06 `_db.md`: every event of the most recent 90 days stays local. */
export const AUDIT_RECENT_DAYS = 90;
/**
 * PowerSync keeps each synced row twice (the typed table and its operation log), so the measured
 * column bytes are doubled. An estimate of physical size, deliberately conservative.
 */
export const AUDIT_STORAGE_FACTOR = 2;
/** Kept window subscriptions survive this long without the app re-subscribing (seconds). */
export const AUDIT_SUBSCRIPTION_TTL_SECONDS = 7 * 24 * 60 * 60;

export type AuditStoreName = 'campaign' | 'private';

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/** UTC `YYYY-MM` of `date`. */
export function auditMonth(date: Date): string {
  return date.toISOString().slice(0, 7);
}

function previousMonth(month: string): string {
  const [year, value] = month.split('-').map(Number) as [number, number];
  return value === 1 ? `${year - 1}-12` : `${year}-${String(value - 1).padStart(2, '0')}`;
}

/** Inclusive, newest first. */
function monthsDown(from: string, to: string): string[] {
  const months: string[] = [];
  for (let month = from; month >= to; month = previousMonth(month)) months.push(month);
  return months;
}

export interface AuditWindowPlan {
  /** Subscribed months, newest first. */
  readonly months: readonly string[];
  /** Months to unsubscribe (their rows leave the device). */
  readonly evicted: readonly string[];
  /** The device may not hold the campaign's whole authority history. */
  readonly partial: boolean;
  /** Estimated local bytes of the kept months (both stores). */
  readonly bytes: number;
}

/**
 * Decides the local window of one campaign. Keeps every month overlapping the newest
 * `recentDays` (even above the budget), then the months already held, newest first, while the
 * total stays within `budgetBytes`; the first that does not fit is evicted with all older ones.
 * When nothing was evicted and room remains, one older month is added per plan (measured on the
 * next plan), back to the campaign's first month.
 */
export function planAuditWindow(input: {
  readonly now: Date;
  readonly current: readonly string[];
  /** Measured local bytes per month (both stores). */
  readonly usage: Readonly<Record<string, number>>;
  /** UTC month the campaign's history starts; `undefined` when unknown. */
  readonly historyStart?: string;
  readonly budgetBytes?: number;
  readonly recentDays?: number;
}): AuditWindowPlan {
  const budget = input.budgetBytes ?? AUDIT_LOCAL_BUDGET_BYTES;
  const newest = auditMonth(input.now);
  const recentFrom = auditMonth(
    new Date(input.now.getTime() - (input.recentDays ?? AUDIT_RECENT_DAYS) * 86_400_000),
  );
  const start =
    input.historyStart !== undefined && MONTH.test(input.historyStart)
      ? input.historyStart
      : undefined;
  const floor = start !== undefined && start > recentFrom ? start : recentFrom;
  const months = monthsDown(newest, floor);
  const size = (month: string) => Math.max(0, input.usage[month] ?? 0);
  let bytes = months.reduce((total, month) => total + size(month), 0);
  const older = [...new Set(input.current.filter((month) => MONTH.test(month) && month < floor))]
    .filter((month) => start === undefined || month >= start)
    .sort()
    .reverse();
  const evicted: string[] = [];
  for (const month of older) {
    if (evicted.length === 0 && bytes + size(month) <= budget) {
      months.push(month);
      bytes += size(month);
    } else evicted.push(month);
  }
  let grew = false;
  const oldest = months.at(-1) ?? newest;
  if (evicted.length === 0 && bytes < budget && start !== undefined && oldest > start) {
    months.push(previousMonth(oldest));
    grew = true;
  }
  const kept = months.at(-1) ?? newest;
  return {
    months,
    evicted,
    partial: start === undefined || kept > start || grew || evicted.length > 0,
    bytes,
  };
}

/** The subset of the browser database the audit replica needs. */
export interface AuditSqlDatabase {
  execute(sql: string, parameters?: unknown[]): Promise<unknown>;
  getAll<T>(sql: string, parameters?: unknown[]): Promise<T[]>;
  getOptional<T>(sql: string, parameters?: unknown[]): Promise<T | null>;
}

export interface AuditLogQuery {
  readonly campaignId: string;
  readonly store: AuditStoreName;
  readonly sessionId?: string;
  readonly actorUserId?: string;
  readonly targetType?: string;
  readonly targetId?: string;
  readonly limit?: number;
}

export type LocalAuditState = 'accepted' | 'pending' | 'conflicted' | 'rejected';

/** One local entry. `pending`/`conflicted`/`rejected` are not authority-accepted history. */
export interface LocalAuditEntry {
  readonly id: string;
  readonly state: LocalAuditState;
  readonly campaignId: string;
  readonly sessionId: string | null;
  readonly actor: { readonly userId: string; readonly role: string };
  readonly action: string;
  readonly target: { readonly type: string; readonly id: string };
  /** Authority acceptance time, or the local recording time of an unaccepted event. */
  readonly at: string;
  readonly before?: Record<string, unknown>;
  readonly after?: Record<string, unknown>;
  readonly rendererVersion: number;
}

export interface LocalAuditLog {
  readonly entries: readonly LocalAuditEntry[];
  /** Older authority history may be missing on this device (window, eviction, never synced). */
  readonly partial: boolean;
  readonly pendingCount: number;
}

export type LocalAuditRead =
  | { readonly ok: true; readonly log: LocalAuditLog }
  /** The private store is not on this device (no GM role): nothing to address. */
  | { readonly ok: false; readonly reason: 'private_unavailable' };

interface AcceptedRow {
  readonly id: string;
  readonly campaign_id: string;
  readonly session_id: string | null;
  readonly actor_user_id: string;
  readonly actor_role: string;
  readonly action: string;
  readonly target_type: string;
  readonly target_id: string;
  readonly before_value: string | null;
  readonly after_value: string | null;
  readonly accepted_at: string;
  readonly renderer_version: number;
}

interface QueuedRow {
  readonly id: string;
  readonly state: string;
  readonly payload: string | null;
  readonly recorded_at: string;
  readonly causal_sequence: number;
}

interface WindowRow {
  readonly months: string;
  readonly partial: number;
  readonly private_subscribed: number | null;
}

const BYTES = `(length(id) + length(campaign_id) + coalesce(length(session_id), 0)
  + length(actor_user_id) + length(actor_role) + length(action) + length(target_type)
  + length(target_id) + coalesce(length(before_value), 0) + coalesce(length(after_value), 0)
  + coalesce(length(client_recorded_at), 0) + length(accepted_at) + 8)`;

export class AuditReplicaStore {
  constructor(
    private readonly db: AuditSqlDatabase,
    /** Whether the private table exists in this replica's schema (a GM role somewhere). */
    private readonly privateTable: () => boolean,
    /** The replicated campaign row's creation time (feature 02 owns the table). */
    private readonly campaignCreatedAt: (
      campaignId: string,
    ) => Promise<string | undefined> = async () => undefined,
  ) {}

  /** Estimated local bytes per accepted UTC month, both stores together. */
  async usage(campaignId: string): Promise<Record<string, number>> {
    const usage: Record<string, number> = {};
    for (const table of this.#tables()) {
      const rows = await this.db.getAll<{ month: string; bytes: number }>(
        `SELECT substr(accepted_at, 1, 7) AS month, sum(${BYTES}) AS bytes
         FROM ${table} WHERE campaign_id = ? GROUP BY substr(accepted_at, 1, 7)`,
        [campaignId],
      );
      for (const row of rows) {
        usage[row.month] = (usage[row.month] ?? 0) + Number(row.bytes) * AUDIT_STORAGE_FACTOR;
      }
    }
    return usage;
  }

  /** UTC month the campaign was created (no audit history before it). */
  async historyStart(campaignId: string): Promise<string | undefined> {
    const month = (await this.campaignCreatedAt(campaignId).catch(() => undefined))?.slice(0, 7);
    return month !== undefined && MONTH.test(month) ? month : undefined;
  }

  async window(
    campaignId: string,
  ): Promise<{ months: string[]; partial: boolean; privateSubscribed: boolean } | undefined> {
    const row = await this.db.getOptional<WindowRow>(
      'SELECT months, partial, private_subscribed FROM sync_audit_window WHERE id = ?',
      [campaignId],
    );
    if (row === null) return undefined;
    const months = parseMonths(row.months);
    return {
      months,
      partial: Number(row.partial) !== 0,
      privateSubscribed: Number(row.private_subscribed ?? 0) !== 0,
    };
  }

  /** Local-only window state (PowerSync tables are views: read, then insert or update). */
  async saveWindow(
    campaignId: string,
    plan: AuditWindowPlan,
    privateSubscribed: boolean,
    at: string,
  ): Promise<void> {
    const values = [
      JSON.stringify(plan.months),
      plan.partial ? 1 : 0,
      plan.bytes,
      privateSubscribed ? 1 : 0,
      at,
    ];
    const existing = await this.db.getOptional<{ id: string }>(
      'SELECT id FROM sync_audit_window WHERE id = ?',
      [campaignId],
    );
    if (existing === null) {
      await this.db.execute(
        `INSERT INTO sync_audit_window
           (id, campaign_id, months, partial, bytes, private_subscribed, planned_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [campaignId, campaignId, ...values],
      );
    } else {
      await this.db.execute(
        `UPDATE sync_audit_window
         SET months = ?, partial = ?, bytes = ?, private_subscribed = ?, planned_at = ? WHERE id = ?`,
        [...values, campaignId],
      );
    }
  }

  /** Pending local events above accepted history, both narrowed by the same filters. */
  async read(query: AuditLogQuery): Promise<LocalAuditRead> {
    if (query.store === 'private' && !this.privateTable()) {
      return { ok: false, reason: 'private_unavailable' };
    }
    const table = query.store === 'private' ? AUDIT_PRIVATE_TABLE : AUDIT_CAMPAIGN_TABLE;
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 500);
    const filters = ['campaign_id = ?'];
    const parameters: unknown[] = [query.campaignId];
    for (const [column, value] of [
      ['session_id', query.sessionId],
      ['actor_user_id', query.actorUserId],
      ['target_type', query.targetType],
      ['target_id', query.targetId],
    ] as const) {
      if (value !== undefined) {
        filters.push(`${column} = ?`);
        parameters.push(value);
      }
    }
    const accepted = await this.db.getAll<AcceptedRow>(
      `SELECT id, campaign_id, session_id, actor_user_id, actor_role, action, target_type,
              target_id, before_value, after_value, accepted_at, renderer_version
       FROM ${table} WHERE ${filters.join(' AND ')}
       ORDER BY accepted_at DESC, id DESC LIMIT ?`,
      [...parameters, limit],
    );
    const queued = await this.db.getAll<QueuedRow>(
      `SELECT id, state, payload, recorded_at, causal_sequence FROM sync_pending_mutations
       WHERE campaign_id = ? AND state != 'accepted' ORDER BY causal_sequence DESC`,
      [query.campaignId],
    );
    const pending = queued.flatMap((row) => {
      const audit = queuedAudit(row.payload);
      if (audit === undefined || audit.campaignId !== query.campaignId) return [];
      if ((audit.private === true) !== (query.store === 'private')) return [];
      if (query.sessionId !== undefined && audit.sessionId !== query.sessionId) return [];
      if (query.actorUserId !== undefined && audit.actor?.userId !== query.actorUserId) return [];
      if (query.targetType !== undefined && audit.targetType !== query.targetType) return [];
      if (query.targetId !== undefined && audit.targetId !== query.targetId) return [];
      return [pendingEntry(row, audit)];
    });
    const window = await this.window(query.campaignId);
    return {
      ok: true,
      log: {
        entries: [...pending, ...accepted.map(acceptedEntry)].slice(0, limit),
        partial: window === undefined || window.partial,
        pendingCount: pending.filter((entry) => entry.state === 'pending').length,
      },
    };
  }

  /** ID of the newest accepted event this replica holds for the campaign in `store`. */
  async newestAccepted(campaignId: string, store: AuditStoreName): Promise<string | undefined> {
    if (store === 'private' && !this.privateTable()) return undefined;
    const row = await this.db.getOptional<{ id: string }>(
      `SELECT id FROM ${store === 'private' ? AUDIT_PRIVATE_TABLE : AUDIT_CAMPAIGN_TABLE}
       WHERE campaign_id = ? ORDER BY accepted_at DESC, id DESC LIMIT 1`,
      [campaignId],
    );
    return row?.id ?? undefined;
  }

  /** Whether the private table exists in this replica's schema. */
  hasPrivateTable(): boolean {
    return this.privateTable();
  }

  #tables(): string[] {
    return this.privateTable()
      ? [AUDIT_CAMPAIGN_TABLE, AUDIT_PRIVATE_TABLE]
      : [AUDIT_CAMPAIGN_TABLE];
  }
}

/** One subscription handle as the provider SDK returns it. */
export interface AuditStreamHandle {
  unsubscribe(): void;
}

/** Provider stream port (`PowerSyncDatabase.syncStream`), injected so tests can observe it. */
export interface AuditStreams {
  subscribe(
    stream: string,
    parameters: Readonly<Record<string, string>>,
  ): Promise<AuditStreamHandle>;
  /** Removes the persisted subscription, so the provider drops its rows. */
  forget(stream: string, parameters: Readonly<Record<string, string>>): Promise<void>;
  /**
   * The subscription has been delivered at least once (provider stream status). Absent: nothing
   * is ever claimed as synced, so no acknowledgement is made.
   */
  synced?(stream: string, parameters: Readonly<Record<string, string>>): boolean;
}

/**
 * Feature 06 retention follow-up: what this replica tells the authority it holds, per audit store.
 * `throughEventId` is the newest accepted event held locally; every older event visible to the
 * user is either held too (its window has synced) or deliberately not kept (compaction). The
 * authority resolves the ID to its sequence; the device never learns sequences.
 */
export interface AuditAcknowledgement {
  readonly campaignId: string;
  readonly tableName: typeof AUDIT_CAMPAIGN_TABLE | typeof AUDIT_PRIVATE_TABLE;
  readonly throughEventId: string;
}

/**
 * Applies window plans as stream subscriptions. A campaign's private stream is subscribed only
 * while the cached membership holds a GM role there; losing it forgets every private window of
 * that campaign (the provider query stops matching anyway).
 */
export class AuditWindowManager {
  readonly #active = new Map<string, AuditStreamHandle>();

  constructor(
    private readonly store: AuditReplicaStore,
    private readonly streams: AuditStreams,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /** Re-plans and applies one campaign; returns the plan. */
  async refresh(
    campaignId: string,
    access: {
      /**
       * The cached role is a GM role here. A client hint only: the stream query decides, and a
       * player never subscribes, so its replica never addresses the private store.
       */
      readonly privateStore: boolean;
    },
  ): Promise<AuditWindowPlan> {
    const previous = await this.store.window(campaignId);
    const plan = planAuditWindow({
      now: this.clock(),
      current: previous?.months ?? [],
      usage: await this.store.usage(campaignId),
      historyStart: await this.store.historyStart(campaignId),
    });
    const gm = access.privateStore;
    const wanted = new Set<string>();
    for (const month of plan.months) {
      wanted.add(key(AUDIT_CAMPAIGN_STREAM, campaignId, month));
      if (gm) wanted.add(key(AUDIT_PRIVATE_STREAM, campaignId, month));
    }
    for (const month of plan.months) {
      for (const stream of gm
        ? [AUDIT_CAMPAIGN_STREAM, AUDIT_PRIVATE_STREAM]
        : [AUDIT_CAMPAIGN_STREAM]) {
        const id = key(stream, campaignId, month);
        if (!this.#active.has(id)) {
          this.#active.set(
            id,
            await this.streams.subscribe(stream, windowParameters(campaignId, month)),
          );
        }
      }
    }
    const known = new Set([...(previous?.months ?? []), ...plan.evicted, ...plan.months]);
    // Only streams this device ever subscribed are forgotten: a player never addresses the
    // private stream, not even to unsubscribe.
    const hadPrivate = previous?.privateSubscribed === true || this.#hasPrivate(campaignId);
    const streams = hadPrivate
      ? [AUDIT_CAMPAIGN_STREAM, AUDIT_PRIVATE_STREAM]
      : [AUDIT_CAMPAIGN_STREAM];
    for (const month of known) {
      for (const stream of streams) {
        const id = key(stream, campaignId, month);
        if (wanted.has(id)) continue;
        this.#active.get(id)?.unsubscribe();
        this.#active.delete(id);
        await this.streams.forget(stream, windowParameters(campaignId, month));
      }
    }
    await this.store.saveWindow(campaignId, plan, gm, this.clock().toISOString());
    return plan;
  }

  /** A purged campaign: every window subscription leaves (its local state is dropped elsewhere). */
  async forgetCampaign(
    campaignId: string,
    previous:
      | { readonly months: readonly string[]; readonly privateSubscribed: boolean }
      | undefined,
  ): Promise<void> {
    const months = previous?.months ?? [];
    const streams =
      previous?.privateSubscribed === true || this.#hasPrivate(campaignId)
        ? [AUDIT_CAMPAIGN_STREAM, AUDIT_PRIVATE_STREAM]
        : [AUDIT_CAMPAIGN_STREAM];
    const known = new Set([
      ...months,
      ...[...this.#active.keys()]
        .filter((id) => id.split('|')[1] === campaignId)
        .map((id) => id.split('|')[2] ?? ''),
    ]);
    for (const month of known) {
      for (const stream of streams) {
        const id = key(stream, campaignId, month);
        this.#active.get(id)?.unsubscribe();
        this.#active.delete(id);
        await this.streams.forget(stream, windowParameters(campaignId, month));
      }
    }
  }

  /**
   * Acknowledgements this replica can truthfully make for one campaign now: per store, only when
   * every month of its current window is subscribed here and has synced, and only naming an event
   * it holds. A store with no held event, an unsynced window, or (private) no GM subscription
   * makes no claim, so its watermark simply does not advance.
   */
  async acknowledgements(campaignId: string): Promise<AuditAcknowledgement[]> {
    const window = await this.store.window(campaignId);
    if (window === undefined || window.months.length === 0) return [];
    const stores: [AuditStoreName, string, AuditAcknowledgement['tableName']][] = [
      ['campaign', AUDIT_CAMPAIGN_STREAM, AUDIT_CAMPAIGN_TABLE],
    ];
    if (window.privateSubscribed && this.store.hasPrivateTable()) {
      stores.push(['private', AUDIT_PRIVATE_STREAM, AUDIT_PRIVATE_TABLE]);
    }
    const acknowledgements: AuditAcknowledgement[] = [];
    for (const [store, stream, tableName] of stores) {
      const synced = window.months.every(
        (month) =>
          this.#active.has(key(stream, campaignId, month)) &&
          this.streams.synced?.(stream, windowParameters(campaignId, month)) === true,
      );
      if (!synced) continue;
      const throughEventId = await this.store.newestAccepted(campaignId, store);
      if (throughEventId !== undefined) {
        acknowledgements.push({ campaignId, tableName, throughEventId });
      }
    }
    return acknowledgements;
  }

  #hasPrivate(campaignId: string): boolean {
    return [...this.#active.keys()].some((id) =>
      id.startsWith(`${AUDIT_PRIVATE_STREAM}|${campaignId}|`),
    );
  }

  /** Active subscriptions as `stream|campaign|month` (for tests and diagnostics). */
  active(): string[] {
    return [...this.#active.keys()].sort();
  }
}

function key(stream: string, campaignId: string, month: string): string {
  return `${stream}|${campaignId}|${month}`;
}

function windowParameters(campaignId: string, month: string): Record<string, string> {
  return { campaign_id: campaignId, month };
}

function parseMonths(text: string): string[] {
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value)
      ? value.filter((month): month is string => typeof month === 'string' && MONTH.test(month))
      : [];
  } catch {
    return [];
  }
}

function queuedAudit(payload: string | null): MutationAuditPayload | undefined {
  if (payload === null) return undefined;
  try {
    const audit: unknown = (JSON.parse(payload) as { audit?: unknown }).audit;
    return isValidMutationAudit(audit) ? audit : undefined;
  } catch {
    return undefined;
  }
}

function pendingEntry(row: QueuedRow, audit: MutationAuditPayload): LocalAuditEntry {
  const state: LocalAuditState =
    row.state === 'rejected' ? 'rejected' : row.state === 'conflicted' ? 'conflicted' : 'pending';
  return {
    id: row.id,
    state,
    campaignId: audit.campaignId,
    sessionId: audit.sessionId ?? null,
    actor: { userId: audit.actor?.userId ?? '', role: audit.actor?.role ?? '' },
    action: audit.action,
    target: { type: audit.targetType, id: audit.targetId },
    at: row.recorded_at,
    ...(audit.before === undefined ? {} : { before: audit.before }),
    ...(audit.after === undefined ? {} : { after: audit.after }),
    rendererVersion: 0,
  };
}

function acceptedEntry(row: AcceptedRow): LocalAuditEntry {
  const before = jsonObject(row.before_value);
  const after = jsonObject(row.after_value);
  return {
    id: row.id,
    state: 'accepted',
    campaignId: row.campaign_id,
    sessionId: row.session_id ?? null,
    actor: { userId: row.actor_user_id, role: row.actor_role },
    action: row.action,
    target: { type: row.target_type, id: row.target_id },
    at: row.accepted_at,
    ...(before === undefined ? {} : { before }),
    ...(after === undefined ? {} : { after }),
    rendererVersion: Number(row.renderer_version),
  };
}

function jsonObject(text: string | null): Record<string, unknown> | undefined {
  if (text === null) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
