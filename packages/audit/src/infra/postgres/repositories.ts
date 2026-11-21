import { type SQL, sql } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import type { AuditLocatedEvent } from '../../acknowledgement.ts';
import {
  type AccountAuditEnvelope,
  type AuditAppender,
  type AuditAppendResult,
  type AuditEnvelope,
  type AuditSqlExecutor,
  type CampaignAuditEnvelope,
  type CampaignAuditStoreName,
  isAuditId,
} from '../../model.ts';
import type { AuditEventReader, AuditReadScope, AuditTargetGroup } from '../../query.ts';
import type { AuditParkInput, AuditRepairEntry, AuditRepairOutbox } from '../../recorder.ts';
import {
  auditAccountEvents,
  auditCampaignEvents,
  auditCampaignSequences,
  auditPrivateEvents,
  auditPrivateSequences,
  auditRepairOutbox,
  auditSchema,
} from './schema.ts';

export type AuditDatabase = PostgresJsDatabase<typeof auditSchema>;

export interface AuditDatabaseConnection {
  readonly db: AuditDatabase;
  close(): Promise<void>;
}

export function connectAuditDatabase(
  connectionString: string,
  options: { readonly max?: number } = {},
): AuditDatabaseConnection {
  const client = postgres(connectionString, {
    max: options.max ?? 4,
    prepare: false,
    onnotice: () => undefined,
  });
  return {
    db: drizzle(client, { schema: auditSchema, logger: false }),
    close: async () => client.end(),
  };
}

/** A stored campaign or GM-private event, as read from exactly one physical store. */
export interface StoredCampaignAuditEvent {
  readonly id: string;
  readonly campaignId: string;
  readonly sessionId: string | null;
  readonly campaignSequence: number;
  readonly actorUserId: string;
  readonly actorRole: string;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly targetVisibility: unknown;
  readonly beforeValue: unknown;
  readonly afterValue: unknown;
  readonly clientRecordedAt: Date;
  readonly acceptedAt: Date;
  readonly originMutationId: string;
  readonly rendererVersion: number;
}

async function rows<T>(executor: AuditSqlExecutor, query: SQL): Promise<T[]> {
  return (await executor.execute(query)) as T[];
}

const json = (value: unknown) =>
  value === undefined ? sql`null` : sql`${JSON.stringify(value)}::jsonb`;

/**
 * Runs `work` in a nested transaction (a savepoint inside the caller's transaction), so
 * its failure never aborts the caller. postgres.js rolls back a whole transaction on any
 * failed query, so a raw SAVEPOINT statement would not isolate it.
 */
function isolated<T>(
  executor: AuditSqlExecutor,
  work: (nested: AuditSqlExecutor) => Promise<T>,
): Promise<T> {
  return executor.transaction(work);
}

type CampaignEventsTable = typeof auditCampaignEvents | typeof auditPrivateEvents;
type SequenceTable = typeof auditCampaignSequences | typeof auditPrivateSequences;

/**
 * Not exported: each physical store is reachable only through its own named repository,
 * bound to its table at construction. No read path takes a store/privacy argument.
 */
abstract class CampaignScopedAuditRepository
  implements AuditAppender<CampaignAuditEnvelope>, AuditEventReader
{
  protected abstract readonly store: CampaignAuditStoreName;
  protected abstract readonly table: CampaignEventsTable;
  protected abstract readonly sequences: SequenceTable;

  constructor(private readonly db: AuditDatabase) {}

  append(envelope: CampaignAuditEnvelope): Promise<AuditAppendResult> {
    this.#assertRouted(envelope);
    return this.db.transaction((transaction) => this.#insert(transaction, envelope));
  }

  appendWithin(
    executor: AuditSqlExecutor,
    envelope: CampaignAuditEnvelope,
  ): Promise<AuditAppendResult> {
    this.#assertRouted(envelope);
    return isolated(executor, (nested) => this.#insert(nested, envelope));
  }

  /** Newest first by authority sequence; `beforeSequence` is the cursor. */
  async listForCampaign(
    campaignId: string,
    page: { readonly limit: number; readonly beforeSequence?: number },
  ): Promise<readonly StoredCampaignAuditEvent[]> {
    const table = this.table;
    const cursor =
      page.beforeSequence === undefined
        ? sql``
        : sql` and ${table.campaignSequence} < ${page.beforeSequence}`;
    const found = await rows<Record<string, unknown>>(
      this.db,
      sql`select * from ${table} where ${table.campaignId} = ${campaignId}${cursor}
          order by ${table.campaignSequence} desc limit ${Math.max(1, Math.min(page.limit, 200))}`,
    );
    return found.map(toStoredCampaignEvent);
  }

  /** Distinct (target, stored snapshot) groups in scope, for the reader's authorization pass. */
  async targetGroups(scope: AuditReadScope): Promise<readonly AuditTargetGroup[]> {
    const table = this.table;
    const found = await rows<{ target_type: string; target_id: string; snapshot_text: string }>(
      this.db,
      sql`select distinct ${table.targetType} as target_type, ${table.targetId}::text as target_id,
                 ${table.targetVisibility}::text as snapshot_text
          from ${table} where ${this.#scope(scope)}`,
    );
    return found.map((row) => ({
      targetType: row.target_type,
      targetId: row.target_id,
      snapshotText: row.snapshot_text,
      snapshot: parseSnapshot(row.snapshot_text),
    }));
  }

  async countWithin(scope: AuditReadScope, groups: readonly AuditTargetGroup[]): Promise<number> {
    if (groups.length === 0) return 0;
    const [counted] = await rows<{ total: string | number }>(
      this.db,
      sql`select count(*) as total from ${this.table}
          where ${this.#scope(scope)} and ${this.#within(groups)}`,
    );
    return Number(counted?.total ?? 0);
  }

  async pageWithin(
    scope: AuditReadScope,
    groups: readonly AuditTargetGroup[],
    page: { readonly limit: number; readonly cursor?: string },
  ): Promise<readonly StoredCampaignAuditEvent[] | undefined> {
    const table = this.table;
    if (groups.length === 0) return page.cursor === undefined ? [] : undefined;
    let before = sql``;
    if (page.cursor !== undefined) {
      // The cursor resolves only among permitted rows in scope: a hidden or unknown event ID is
      // the same invalid cursor.
      if (!isAuditId(page.cursor)) return undefined;
      const [anchor] = await rows<{ sequence: string | number }>(
        this.db,
        sql`select ${table.campaignSequence} as sequence from ${table}
            where ${table.id} = ${page.cursor} and ${this.#scope(scope)} and ${this.#within(groups)}`,
      );
      if (anchor === undefined) return undefined;
      before = sql` and ${table.campaignSequence} < ${Number(anchor.sequence)}`;
    }
    const found = await rows<Record<string, unknown>>(
      this.db,
      sql`select * from ${table} where ${this.#scope(scope)} and ${this.#within(groups)}${before}
          order by ${table.campaignSequence} desc
          limit ${Math.max(1, Math.min(page.limit, MAX_READ_PAGE))}`,
    );
    return found.map(toStoredCampaignEvent);
  }

  /** One event of this store in the campaign (replica acknowledgement); unknown: `undefined`. */
  async locate(campaignId: string, eventId: string): Promise<AuditLocatedEvent | undefined> {
    if (!isAuditId(campaignId) || !isAuditId(eventId)) return undefined;
    const table = this.table;
    const [found] = await rows<{
      target_type: string;
      target_id: string;
      snapshot_text: string;
      sequence: string | number;
    }>(
      this.db,
      sql`select ${table.targetType} as target_type, ${table.targetId}::text as target_id,
                 ${table.targetVisibility}::text as snapshot_text,
                 ${table.campaignSequence} as sequence
          from ${table} where ${table.id} = ${eventId} and ${table.campaignId} = ${campaignId}`,
    );
    return found === undefined
      ? undefined
      : {
          targetType: found.target_type,
          targetId: found.target_id,
          snapshot: parseSnapshot(found.snapshot_text),
          sequence: Number(found.sequence),
        };
  }

  #scope(scope: AuditReadScope): SQL {
    const table = this.table;
    const parts: SQL[] = [sql`${table.campaignId} = ${scope.campaignId}`];
    if (scope.sessionId !== undefined) parts.push(sql`${table.sessionId} = ${scope.sessionId}`);
    if (scope.actorUserId !== undefined) {
      parts.push(sql`${table.actorUserId} = ${scope.actorUserId}`);
    }
    if (scope.targetType !== undefined) parts.push(sql`${table.targetType} = ${scope.targetType}`);
    if (scope.targetId !== undefined) parts.push(sql`${table.targetId} = ${scope.targetId}`);
    return sql.join(parts, sql` and `);
  }

  /** Restricts to the permitted groups, comparing the stored snapshot as jsonb. */
  #within(groups: readonly AuditTargetGroup[]): SQL {
    const table = this.table;
    const payload = JSON.stringify(
      groups.map((group) => ({ t: group.targetType, i: group.targetId, v: group.snapshotText })),
    );
    return sql`exists (
      select 1 from jsonb_to_recordset(${payload}::jsonb) as permitted(t text, i uuid, v text)
      where permitted.t = ${table.targetType} and permitted.i = ${table.targetId}
        and permitted.v::jsonb = ${table.targetVisibility})`;
  }

  #assertRouted(envelope: CampaignAuditEnvelope): void {
    if (envelope.store !== this.store || envelope.event.private !== (this.store === 'private')) {
      throw new Error('audit_store_mismatch');
    }
  }

  async #insert(
    executor: AuditSqlExecutor,
    envelope: CampaignAuditEnvelope,
  ): Promise<AuditAppendResult> {
    const { event } = envelope;
    const table = this.table;
    const sequences = this.sequences;
    await executor.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`audit:${this.store}:${envelope.originMutationId}`}, 0))`,
    );
    const [existing] = await rows<{ id: string; sequence: string | number }>(
      executor,
      sql`select id, campaign_sequence as sequence from ${table}
          where origin_mutation_id = ${envelope.originMutationId} or id = ${envelope.eventId}
          limit 1`,
    );
    if (existing !== undefined) {
      return { status: 'duplicate', eventId: existing.id, sequence: Number(existing.sequence) };
    }
    const [allocated] = await rows<{ sequence: string | number }>(
      executor,
      sql`insert into ${sequences} (campaign_id, last_sequence) values (${event.campaignId}, 1)
          on conflict (campaign_id) do update set last_sequence = ${sequences}.last_sequence + 1
          returning last_sequence as sequence`,
    );
    if (allocated === undefined) throw new Error('audit_sequence_unavailable');
    const sequence = Number(allocated.sequence);
    await executor.execute(sql`
      insert into ${table} (
        id, campaign_id, session_id, campaign_sequence, actor_user_id, actor_role, action,
        target_type, target_id, target_visibility, before_value, after_value,
        client_recorded_at, accepted_at, origin_mutation_id, renderer_version
      ) values (
        ${envelope.eventId}, ${event.campaignId}, ${event.sessionId ?? null}, ${sequence},
        ${event.actor.userId}, ${event.actor.role}, ${event.action}, ${event.targetType},
        ${event.targetId}, ${json(envelope.targetVisibility)}, ${json(event.before)},
        ${json(event.after)}, ${event.at}::timestamptz, transaction_timestamp(),
        ${envelope.originMutationId}, ${envelope.rendererVersion}
      )`);
    return { status: 'inserted', eventId: envelope.eventId, sequence };
  }
}

/** Campaign-visible store, subject to feature 04 target visibility on read and sync. */
export class CampaignAuditRepository extends CampaignScopedAuditRepository {
  protected readonly store = 'campaign' as const;
  protected readonly table = auditCampaignEvents;
  protected readonly sequences = auditCampaignSequences;
}

/** GM-private store. Never synchronized to a non-GM replica (feature 06 FR-003). */
export class PrivateAuditRepository extends CampaignScopedAuditRepository {
  protected readonly store = 'private' as const;
  protected readonly table = auditPrivateEvents;
  protected readonly sequences = auditPrivateSequences;
}

/** Operator-only account store. No campaign reader and no sync stream. */
export class AccountAuditRepository implements AuditAppender<AccountAuditEnvelope> {
  constructor(private readonly db: AuditDatabase) {}

  append(envelope: AccountAuditEnvelope): Promise<AuditAppendResult> {
    return this.db.transaction((transaction) => this.#insert(transaction, envelope));
  }

  appendWithin(
    executor: AuditSqlExecutor,
    envelope: AccountAuditEnvelope,
  ): Promise<AuditAppendResult> {
    return isolated(executor, (nested) => this.#insert(nested, envelope));
  }

  async #insert(
    executor: AuditSqlExecutor,
    envelope: AccountAuditEnvelope,
  ): Promise<AuditAppendResult> {
    if (envelope.store !== 'account') throw new Error('audit_store_mismatch');
    const { event } = envelope;
    const table = auditAccountEvents;
    await executor.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`audit:account:${envelope.originMutationId}`}, 0))`,
    );
    const [existing] = await rows<{ id: string; sequence: string | number }>(
      executor,
      sql`select id, account_sequence as sequence from ${table}
          where origin_mutation_id = ${envelope.originMutationId} or id = ${envelope.eventId}
          limit 1`,
    );
    if (existing !== undefined) {
      return { status: 'duplicate', eventId: existing.id, sequence: Number(existing.sequence) };
    }
    const actorUserId = event.actor.kind === 'user' ? event.actor.userId : null;
    const actorReference = event.actor.kind === 'operator' ? (event.actor.reference ?? null) : null;
    const [inserted] = await rows<{ sequence: string | number }>(
      executor,
      sql`
        insert into ${table} (
          id, subject_user_id, actor_kind, actor_user_id, actor_reference, action, target_type,
          target_id, before_value, after_value, client_recorded_at, accepted_at,
          origin_mutation_id, renderer_version
        ) values (
          ${envelope.eventId}, ${event.subjectUserId}, ${event.actor.kind}, ${actorUserId},
          ${actorReference}, ${event.action}, ${event.targetType}, ${event.targetId},
          ${json(event.before)}, ${json(event.after)}, ${event.at}::timestamptz,
          transaction_timestamp(), ${envelope.originMutationId}, ${envelope.rendererVersion}
        )
        returning account_sequence as sequence`,
    );
    return { status: 'inserted', eventId: envelope.eventId, sequence: Number(inserted?.sequence) };
  }
}

/** Restricted repair/dead-letter state. Payload stays in PostgreSQL; nothing here logs. */
export class PostgresAuditRepairOutbox implements AuditRepairOutbox {
  constructor(private readonly db: AuditDatabase) {}

  park(input: AuditParkInput): Promise<void> {
    return this.#park(this.db, input);
  }

  parkWithin(executor: AuditSqlExecutor, input: AuditParkInput): Promise<void> {
    return isolated(executor, (nested) => this.#park(nested, input));
  }

  async due(now: Date, limit: number): Promise<readonly AuditRepairEntry[]> {
    const table = auditRepairOutbox;
    const found = await rows<{ envelope: AuditEnvelope; attempt_count: number }>(
      this.db,
      sql`select envelope, attempt_count from ${table}
          where state = 'pending' and next_attempt_at <= ${now.toISOString()}::timestamptz
          order by next_attempt_at limit ${Math.max(1, limit)}`,
    );
    return found.map((row) => ({ envelope: row.envelope, attemptCount: row.attempt_count }));
  }

  async resolve(eventId: string): Promise<void> {
    await this.db.execute(sql`
      update ${auditRepairOutbox} set state = 'repaired', resolved_at = now()
      where event_id = ${eventId} and state <> 'repaired'`);
  }

  async backlog(): Promise<{ readonly pending: number; readonly dead: number }> {
    const [counts] = await rows<{ pending: string | number; dead: string | number }>(
      this.db,
      sql`select count(*) filter (where state = 'pending') as pending,
                 count(*) filter (where state = 'dead') as dead
          from ${auditRepairOutbox}`,
    );
    return { pending: Number(counts?.pending ?? 0), dead: Number(counts?.dead ?? 0) };
  }

  async #park(executor: AuditSqlExecutor, input: AuditParkInput): Promise<void> {
    const { envelope } = input;
    const campaignId =
      'invalid' in envelope ? campaignOf(envelope.invalid) : campaignOf(envelope.event);
    const table = auditRepairOutbox;
    await executor.execute(sql`
      insert into ${table} (
        event_id, store, origin_mutation_id, campaign_id, envelope, state, failure_code,
        attempt_count, next_attempt_at
      ) values (
        ${envelope.eventId}, ${envelope.store}, ${envelope.originMutationId}, ${campaignId},
        ${json(storableEnvelope(envelope))}, ${input.state}, ${input.code}, ${input.attemptCount},
        ${input.nextAttemptAt.toISOString()}::timestamptz
      )
      on conflict (event_id) do update set
        state = excluded.state,
        failure_code = excluded.failure_code,
        attempt_count = greatest(${table}.attempt_count, excluded.attempt_count),
        last_failed_at = now(),
        next_attempt_at = excluded.next_attempt_at,
        resolved_at = null
      where ${table}.state <> 'repaired'`);
  }
}

const MAX_DEAD_LETTER_BYTES = 65_536;

/** Upper bound of one read page (the API asks for at most its own maximum plus one). */
const MAX_READ_PAGE = 201;

function parseSnapshot(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Oversized or unserializable dead letters keep their identifiers but not their values. */
function storableEnvelope(envelope: AuditParkInput['envelope']): unknown {
  try {
    if (JSON.stringify(envelope).length <= MAX_DEAD_LETTER_BYTES) return envelope;
  } catch {
    // Fall through to the identifiers-only record.
  }
  return {
    store: envelope.store,
    eventId: envelope.eventId,
    originMutationId: envelope.originMutationId,
    omitted: 'unstorable',
  };
}

function campaignOf(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || !('campaignId' in value)) return null;
  return isAuditId(value.campaignId) ? value.campaignId : null;
}

function toStoredCampaignEvent(row: Record<string, unknown>): StoredCampaignAuditEvent {
  return {
    id: String(row.id),
    campaignId: String(row.campaign_id),
    sessionId: row.session_id === null ? null : String(row.session_id),
    campaignSequence: Number(row.campaign_sequence),
    actorUserId: String(row.actor_user_id),
    actorRole: String(row.actor_role),
    action: String(row.action),
    targetType: String(row.target_type),
    targetId: String(row.target_id),
    targetVisibility: row.target_visibility,
    beforeValue: row.before_value,
    afterValue: row.after_value,
    clientRecordedAt: toDate(row.client_recorded_at),
    acceptedAt: toDate(row.accepted_at),
    originMutationId: String(row.origin_mutation_id),
    rendererVersion: Number(row.renderer_version),
  };
}

/** The drizzle postgres-js driver returns timestamps as PostgreSQL text. */
function toDate(value: unknown): Date {
  if (value instanceof Date) return value;
  return new Date(
    String(value)
      .replace(' ', 'T')
      .replace(/([+-]\d\d)$/, '$1:00'),
  );
}
