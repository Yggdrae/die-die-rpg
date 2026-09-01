import { Database } from 'bun:sqlite';
import {
  apiError,
  type EntityEnvelope,
  err,
  ok,
  type RepositoryError,
  type Result,
} from '@rpg/contracts';
import {
  type ConflictResolutionChoice,
  type ConflictResolutionResult,
  type LocalMutationInput,
  type MutationConflict,
  type MutationOutcome,
  type PendingMutation,
  SYNC_BOOKKEEPING_LIMIT_BYTES,
} from './model.ts';
import { LOCAL_SCHEMA_SQL, LOCAL_SCHEMA_VERSION } from './sql-schema.ts';

interface RecordRow {
  readonly payload: string;
  readonly version: number;
  readonly deleted_at: string | null;
}

interface CountRow {
  readonly count: number;
}

interface SizeRow {
  readonly bytes: number;
}

interface MutationRow {
  readonly mutation_id: string;
  readonly campaign_id: string;
  readonly feature_id: string;
  readonly table_name: string;
  readonly record_id: string;
  readonly operation: PendingMutation['operation'];
  readonly expected_version: number | null;
  readonly payload: string;
  readonly causal_sequence: number;
  readonly state: PendingMutation['state'];
  readonly attempt_count: number;
  readonly recorded_at: string;
}

interface ConflictRow {
  readonly conflict_id: string;
  readonly mutation_id: string;
  readonly campaign_id: string;
  readonly feature_id: string;
  readonly table_name: string;
  readonly record_id: string;
  readonly expected_version: number;
  readonly actual_version: number;
  readonly submitted_value: string;
  readonly current_value: string;
  readonly detected_at: string;
  readonly resolution_state: MutationConflict['resolutionState'];
}

export interface LocalWriteResult<T> {
  readonly value: T;
  readonly mutationId: string;
  readonly pendingCount: number;
}

export class SqliteReplicaStore {
  readonly #db: Database;
  readonly #capacityBytes: number;

  constructor(
    filename = ':memory:',
    options: { readonly capacityBytes?: number; readonly runMigrations?: boolean } = {},
  ) {
    this.#db = new Database(filename, { create: true, strict: true });
    this.#capacityBytes = options.capacityBytes ?? SYNC_BOOKKEEPING_LIMIT_BYTES;
    this.#db.exec('PRAGMA foreign_keys = ON;');
    if (options.runMigrations ?? true) this.migrate();
  }

  migrate(afterSchema?: (database: Database) => void): void {
    this.applyMigration(LOCAL_SCHEMA_VERSION, LOCAL_SCHEMA_SQL, afterSchema);
  }

  applyMigration(version: number, sql: string, afterSchema?: (database: Database) => void): void {
    const migration = this.#db.transaction(() => {
      const current = this.schemaVersion();
      if (current >= version) return;
      if (version !== current + 1) throw new Error('local_migration_out_of_order');
      this.#db.exec(sql);
      afterSchema?.(this.#db);
      this.#db.exec(`PRAGMA user_version = ${version}`);
    });
    migration.immediate();
  }

  schemaVersion(): number {
    return (
      this.#db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version ?? 0
    );
  }

  close(): void {
    this.#db.close();
  }

  get<T extends EntityEnvelope>(tableName: string, id: string): Result<T, RepositoryError> {
    const row = this.#db
      .query<RecordRow, [string, string]>(
        'SELECT payload, version, deleted_at FROM sync_records WHERE table_name = ? AND id = ?',
      )
      .get(tableName, id);
    return row === null ? err({ kind: 'not_found', id }) : ok(parseJson<T>(row.payload));
  }

  list<T extends EntityEnvelope>(
    tableName: string,
    campaignId: string,
    options: {
      readonly includeDeleted?: boolean;
      readonly limit?: number;
      readonly offset?: number;
    },
  ): T[] {
    const deletedClause = options.includeDeleted ? '' : 'AND deleted_at IS NULL';
    const limit = options.limit ?? -1;
    const offset = options.offset ?? 0;
    const rows = this.#db
      .query<{ payload: string }, [string, string, number, number]>(
        `SELECT payload FROM sync_records
         WHERE table_name = ? AND campaign_id = ? ${deletedClause}
         ORDER BY id LIMIT ? OFFSET ?`,
      )
      .all(tableName, campaignId, limit, offset);
    return rows.map((row) => parseJson<T>(row.payload));
  }

  write<T extends EntityEnvelope>(
    input: LocalMutationInput<T>,
  ): Result<LocalWriteResult<T>, RepositoryError> {
    const operation = this.#db.transaction(() => {
      const current = this.#record(input.tableName, input.value.id);
      if (current === null && input.expectedVersion !== null) {
        return err({ kind: 'not_found' as const, id: input.value.id });
      }
      if (current !== null && input.expectedVersion !== current.version) {
        return err({
          kind: 'version_conflict' as const,
          id: input.value.id,
          expectedVersion: input.expectedVersion ?? 0,
          actualVersion: current.version,
        });
      }

      const version = current === null ? 1 : current.version + 1;
      const value = structuredClone({ ...input.value, version }) as T;
      const payload = canonicalJson(value);
      const auditPayload = canonicalJson(input.audit);
      if (!this.#hasCapacity(input.value.campaignId, payload, auditPayload)) {
        return err(
          apiError('storage_full', 'Offline storage is full. Existing work is preserved.'),
        );
      }
      const sequence = this.#nextSequence(input.value.campaignId);
      this.#db
        .query<unknown, [string, string, string, string, number, string | null]>(
          `INSERT INTO sync_records
            (table_name, id, campaign_id, payload, version, deleted_at, unresolved_conflict)
           VALUES (?, ?, ?, ?, ?, ?, 0)
           ON CONFLICT (table_name, id) DO UPDATE SET
             campaign_id = excluded.campaign_id,
             payload = excluded.payload,
             version = excluded.version,
             deleted_at = excluded.deleted_at,
             unresolved_conflict = 0`,
        )
        .run(
          input.tableName,
          value.id,
          value.campaignId,
          payload,
          version,
          value.deletedAt ?? null,
        );
      this.#insertMutation({
        mutationId: input.mutationId,
        campaignId: value.campaignId,
        featureId: input.featureId,
        tableName: input.tableName,
        recordId: value.id,
        operation: current === null ? 'insert' : 'update',
        expectedVersion: input.expectedVersion,
        payload,
        sequence,
        recordedAt: input.recordedAt,
      });
      this.#db
        .query<unknown, [string, string]>(
          'INSERT INTO sync_audit_envelopes (mutation_id, payload) VALUES (?, ?)',
        )
        .run(input.mutationId, auditPayload);
      return ok({ value, mutationId: input.mutationId, pendingCount: this.pendingCount() });
    });
    return operation.immediate();
  }

  softDelete<T extends EntityEnvelope>(input: {
    readonly tableName: string;
    readonly featureId: string;
    readonly id: string;
    readonly expectedVersion: number;
    readonly mutationId: string;
    readonly recordedAt: string;
    readonly audit: unknown;
  }): Result<{ readonly pendingCount: number }, RepositoryError> {
    const operation = this.#db.transaction(() => {
      const current = this.#record(input.tableName, input.id);
      if (current === null) return err({ kind: 'not_found' as const, id: input.id });
      if (current.version !== input.expectedVersion) {
        return err({
          kind: 'version_conflict' as const,
          id: input.id,
          expectedVersion: input.expectedVersion,
          actualVersion: current.version,
        });
      }
      const previous = parseJson<T>(current.payload);
      const value = {
        ...previous,
        version: current.version + 1,
        deletedAt: input.recordedAt,
        updatedAt: input.recordedAt,
      } as T;
      const payload = canonicalJson(value);
      const auditPayload = canonicalJson(input.audit);
      if (!this.#hasCapacity(value.campaignId, payload, auditPayload)) {
        return err(
          apiError('storage_full', 'Offline storage is full. Existing work is preserved.'),
        );
      }
      const sequence = this.#nextSequence(value.campaignId);
      this.#db
        .query<unknown, [string, number, string, string, string]>(
          `UPDATE sync_records SET payload = ?, version = ?, deleted_at = ?, unresolved_conflict = 0
           WHERE table_name = ? AND id = ?`,
        )
        .run(payload, value.version, input.recordedAt, input.tableName, input.id);
      this.#insertMutation({
        mutationId: input.mutationId,
        campaignId: value.campaignId,
        featureId: input.featureId,
        tableName: input.tableName,
        recordId: input.id,
        operation: 'tombstone',
        expectedVersion: input.expectedVersion,
        payload,
        sequence,
        recordedAt: input.recordedAt,
      });
      this.#db
        .query<unknown, [string, string]>(
          'INSERT INTO sync_audit_envelopes (mutation_id, payload) VALUES (?, ?)',
        )
        .run(input.mutationId, auditPayload);
      return ok({ pendingCount: this.pendingCount() });
    });
    return operation.immediate();
  }

  pending(campaignId: string, limit = 100): PendingMutation[] {
    return this.#db
      .query<MutationRow, [string, number]>(
        `SELECT mutation_id, campaign_id, feature_id, table_name, record_id, operation,
                expected_version, payload, causal_sequence, state, attempt_count, recorded_at
         FROM sync_pending_mutations
         WHERE campaign_id = ? AND state IN ('pending','uploading')
         ORDER BY causal_sequence LIMIT ?`,
      )
      .all(campaignId, limit)
      .map(toMutation);
  }

  pendingCount(campaignId?: string): number {
    const row = campaignId
      ? this.#db
          .query<CountRow, [string]>(
            `SELECT count(*) AS count FROM sync_pending_mutations AS mutation
             WHERE campaign_id = ? AND state != 'accepted'
               AND NOT EXISTS (
                 SELECT 1 FROM sync_conflicts AS conflict
                 WHERE conflict.mutation_id = mutation.mutation_id
                   AND conflict.resolution_state = 'resolved'
               )`,
          )
          .get(campaignId)
      : this.#db
          .query<CountRow, []>(
            `SELECT count(*) AS count FROM sync_pending_mutations AS mutation
             WHERE state != 'accepted'
               AND NOT EXISTS (
                 SELECT 1 FROM sync_conflicts AS conflict
                 WHERE conflict.mutation_id = mutation.mutation_id
                   AND conflict.resolution_state = 'resolved'
               )`,
          )
          .get();
    return row?.count ?? 0;
  }

  markUploading(mutationIds: readonly string[]): void {
    const update = this.#db.query<unknown, [string]>(
      "UPDATE sync_pending_mutations SET state = 'uploading', attempt_count = attempt_count + 1 WHERE mutation_id = ? AND state IN ('pending','uploading')",
    );
    const transaction = this.#db.transaction(() => {
      for (const id of mutationIds) update.run(id);
    });
    transaction.immediate();
  }

  applyOutcomes(outcomes: readonly MutationOutcome[], at: string): MutationConflict[] {
    const conflicts: MutationConflict[] = [];
    const operation = this.#db.transaction(() => {
      for (const outcome of outcomes) {
        const mutation = this.#mutation(outcome.mutationId);
        if (mutation === null || mutation.state === 'accepted') continue;
        if (outcome.status === 'accepted') {
          this.#db
            .query<unknown, [string, string]>(
              `UPDATE sync_pending_mutations
               SET state = 'accepted', payload = NULL, terminal_at = ? WHERE mutation_id = ?`,
            )
            .run(at, outcome.mutationId);
          this.#db
            .query<unknown, [string]>('DELETE FROM sync_audit_envelopes WHERE mutation_id = ?')
            .run(outcome.mutationId);
          this.#db
            .query<unknown, [string, string, string]>(
              `INSERT INTO sync_campaign_state (campaign_id, replica_state, last_server_cursor, last_sync_at)
               VALUES (?, 'available', ?, ?)
               ON CONFLICT (campaign_id) DO UPDATE SET
                 replica_state = 'available', last_server_cursor = excluded.last_server_cursor,
                 last_sync_at = excluded.last_sync_at, last_error_code = NULL`,
            )
            .run(mutation.campaignId, outcome.serverCursor, at);
          continue;
        }
        if (outcome.status === 'error') {
          this.#db
            .query<unknown, [string, string | null, string | null, string]>(
              `UPDATE sync_pending_mutations SET state = ?, next_attempt_at = ?, terminal_at = ?
               WHERE mutation_id = ?`,
            )
            .run(
              outcome.retryable ? 'pending' : 'rejected',
              outcome.retryable ? at : null,
              outcome.retryable ? null : at,
              outcome.mutationId,
            );
          continue;
        }
        const conflict: MutationConflict = {
          kind: 'deferred_version_conflict',
          conflictId: crypto.randomUUID(),
          mutationId: mutation.mutationId,
          campaignId: mutation.campaignId,
          featureId: mutation.featureId,
          table: mutation.tableName,
          id: mutation.recordId,
          expectedVersion: outcome.expectedVersion,
          actualVersion: outcome.actualVersion,
          submittedValue: mutation.payload,
          currentValue: outcome.currentValue,
          detectedAt: at,
          resolutionState: 'unresolved',
        };
        this.#db
          .query<
            unknown,
            [string, string, string, string, string, string, number, number, string, string, string]
          >(
            `INSERT OR IGNORE INTO sync_conflicts
             (conflict_id, mutation_id, campaign_id, feature_id, table_name, record_id,
              expected_version, actual_version, submitted_value, current_value, detected_at,
              resolution_state)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unresolved')`,
          )
          .run(
            conflict.conflictId,
            conflict.mutationId,
            conflict.campaignId,
            conflict.featureId,
            conflict.table,
            conflict.id,
            conflict.expectedVersion,
            conflict.actualVersion,
            canonicalJson(conflict.submittedValue),
            canonicalJson(conflict.currentValue),
            conflict.detectedAt,
          );
        this.#db
          .query<unknown, [string]>(
            "UPDATE sync_pending_mutations SET state = 'conflicted' WHERE mutation_id = ?",
          )
          .run(mutation.mutationId);
        this.#db
          .query<unknown, [string, string]>(
            'UPDATE sync_records SET unresolved_conflict = 1 WHERE table_name = ? AND id = ?',
          )
          .run(mutation.tableName, mutation.recordId);
        conflicts.push(conflict);
      }
    });
    operation.immediate();
    return conflicts;
  }

  conflicts(campaignId: string): MutationConflict[] {
    return this.#db
      .query<ConflictRow, [string]>(
        `SELECT conflict_id, mutation_id, campaign_id, feature_id, table_name, record_id,
                expected_version, actual_version, submitted_value, current_value, detected_at,
                resolution_state
         FROM sync_conflicts WHERE campaign_id = ? AND resolution_state != 'resolved'
         ORDER BY detected_at, conflict_id`,
      )
      .all(campaignId)
      .map(toConflict);
  }

  deferConflict(conflictId: string): void {
    this.#db
      .query<unknown, [string]>(
        "UPDATE sync_conflicts SET resolution_state = 'deferred' WHERE conflict_id = ? AND resolution_state = 'unresolved'",
      )
      .run(conflictId);
  }

  resolveConflict(input: {
    readonly conflictId: string;
    readonly choice: ConflictResolutionChoice;
    readonly resolverUserId: string;
    readonly resolvedAt: string;
    readonly mutationId?: string;
    readonly manualValue?: unknown;
  }): Result<ConflictResolutionResult, RepositoryError> {
    const operation = this.#db.transaction(() => {
      const row = this.#db
        .query<ConflictRow, [string]>(
          `SELECT conflict_id, mutation_id, campaign_id, feature_id, table_name, record_id,
                  expected_version, actual_version, submitted_value, current_value, detected_at,
                  resolution_state
           FROM sync_conflicts WHERE conflict_id = ?`,
        )
        .get(input.conflictId);
      if (row === null || row.resolution_state === 'resolved') {
        return err({ kind: 'not_found' as const, id: input.conflictId });
      }
      if (input.choice === 'manual' && input.manualValue === undefined) {
        return err(apiError('validation_failed', 'Manual conflict resolution needs a value.'));
      }

      const conflict = toConflict(row);
      const authorityValue = versionedValue(
        conflict.currentValue,
        conflict.id,
        conflict.campaignId,
        conflict.actualVersion,
        input.resolvedAt,
      );
      if (authorityValue === undefined) {
        return err(apiError('validation_failed', 'Authority conflict value is invalid.'));
      }
      let resolutionMutationId: string | undefined;
      let localValue = authorityValue;

      if (input.choice !== 'keep_authority') {
        resolutionMutationId = input.mutationId ?? crypto.randomUUID();
        const selected = input.choice === 'resubmit' ? conflict.submittedValue : input.manualValue;
        const resolvedValue = versionedValue(
          selected,
          conflict.id,
          conflict.campaignId,
          conflict.actualVersion + 1,
          input.resolvedAt,
        );
        if (resolvedValue === undefined) {
          return err(apiError('validation_failed', 'Conflict resolution value is invalid.'));
        }
        localValue = resolvedValue;
        const payload = canonicalJson(localValue);
        const audit = canonicalJson({
          campaignId: conflict.campaignId,
          actorUserId: input.resolverUserId,
          action: 'sync.conflict_resolved',
          targetType: conflict.table,
          targetId: conflict.id,
          conflictId: conflict.conflictId,
          choice: input.choice,
          at: input.resolvedAt,
        });
        if (!this.#hasCapacity(conflict.campaignId, payload, audit)) {
          return err(
            apiError('storage_full', 'Offline storage is full. Existing work is preserved.'),
          );
        }
        this.#insertMutation({
          mutationId: resolutionMutationId,
          campaignId: conflict.campaignId,
          featureId: conflict.featureId,
          tableName: conflict.table,
          recordId: conflict.id,
          operation: 'resolution',
          expectedVersion: conflict.actualVersion,
          payload,
          sequence: this.#nextSequence(conflict.campaignId),
          recordedAt: input.resolvedAt,
        });
        this.#db
          .query<unknown, [string, string]>(
            'INSERT INTO sync_audit_envelopes (mutation_id, payload) VALUES (?, ?)',
          )
          .run(resolutionMutationId, audit);
      }

      this.#db
        .query<unknown, [string, string]>(
          `UPDATE sync_pending_mutations
           SET state = 'rejected', payload = NULL, terminal_at = ? WHERE mutation_id = ?`,
        )
        .run(input.resolvedAt, conflict.mutationId);
      this.#db
        .query<unknown, [string]>('DELETE FROM sync_audit_envelopes WHERE mutation_id = ?')
        .run(conflict.mutationId);
      this.#db
        .query<unknown, [string, number, string, string]>(
          `UPDATE sync_records SET payload = ?, version = ?, unresolved_conflict = 0
           WHERE table_name = ? AND id = ?`,
        )
        .run(canonicalJson(localValue), localValue.version, conflict.table, conflict.id);
      this.#db
        .query<unknown, [string, string, string]>(
          `UPDATE sync_conflicts
           SET resolution_state = 'resolved', resolver_user_id = ?, resolved_at = ?
           WHERE conflict_id = ?`,
        )
        .run(input.resolverUserId, input.resolvedAt, conflict.conflictId);

      return ok({
        conflictId: conflict.conflictId,
        choice: input.choice,
        ...(resolutionMutationId === undefined ? {} : { mutationId: resolutionMutationId }),
        resolvedVersion: localValue.version,
      });
    });
    return operation.immediate();
  }

  dropCampaign(campaignId: string): void {
    const drop = this.#db.transaction(() => {
      this.#db
        .query<unknown, [string]>(
          "INSERT INTO sync_campaign_state (campaign_id, replica_state) VALUES (?, 'dropping') ON CONFLICT (campaign_id) DO UPDATE SET replica_state = 'dropping'",
        )
        .run(campaignId);
      for (const table of [
        'sync_conflicts',
        'sync_pending_mutations',
        'sync_records',
        'sync_tombstone_watermarks',
        'sync_long_text_holds',
      ]) {
        this.#db
          .query<unknown, [string]>(`DELETE FROM ${table} WHERE campaign_id = ?`)
          .run(campaignId);
      }
      this.#db
        .query<unknown, [string]>('DELETE FROM sync_campaign_state WHERE campaign_id = ?')
        .run(campaignId);
    });
    drop.immediate();
  }

  campaignIds(): string[] {
    return this.#db
      .query<{ campaign_id: string }, []>('SELECT DISTINCT campaign_id FROM sync_records')
      .all()
      .map((row) => row.campaign_id);
  }

  bookkeepingBytes(campaignId?: string): number {
    const row =
      campaignId === undefined
        ? this.#db
            .query<SizeRow, []>(
              `SELECT
              COALESCE((SELECT sum(length(payload)) FROM sync_pending_mutations WHERE payload IS NOT NULL), 0) +
              COALESCE((SELECT sum(length(payload)) FROM sync_audit_envelopes), 0) +
              COALESCE((SELECT sum(length(submitted_value) + length(current_value)) FROM sync_conflicts), 0)
              AS bytes`,
            )
            .get()
        : this.#db
            .query<SizeRow, [string, string, string]>(
              `SELECT
              COALESCE((SELECT sum(length(payload)) FROM sync_pending_mutations
                        WHERE campaign_id = ? AND payload IS NOT NULL), 0) +
              COALESCE((SELECT sum(length(audit.payload)) FROM sync_audit_envelopes AS audit
                        INNER JOIN sync_pending_mutations AS mutation
                          ON mutation.mutation_id = audit.mutation_id
                        WHERE mutation.campaign_id = ?), 0) +
              COALESCE((SELECT sum(length(submitted_value) + length(current_value))
                        FROM sync_conflicts WHERE campaign_id = ?), 0)
              AS bytes`,
            )
            .get(campaignId, campaignId, campaignId);
    return row?.bytes ?? 0;
  }

  #record(tableName: string, id: string): RecordRow | null {
    return this.#db
      .query<RecordRow, [string, string]>(
        'SELECT payload, version, deleted_at FROM sync_records WHERE table_name = ? AND id = ?',
      )
      .get(tableName, id);
  }

  #mutation(mutationId: string): PendingMutation | null {
    const row = this.#db
      .query<MutationRow, [string]>(
        `SELECT mutation_id, campaign_id, feature_id, table_name, record_id, operation,
                expected_version, payload, causal_sequence, state, attempt_count, recorded_at
         FROM sync_pending_mutations WHERE mutation_id = ?`,
      )
      .get(mutationId);
    return row === null ? null : toMutation(row);
  }

  #hasCapacity(campaignId: string, ...payloads: readonly string[]): boolean {
    const added = payloads.reduce(
      (total, value) => total + new TextEncoder().encode(value).length,
      0,
    );
    return this.bookkeepingBytes(campaignId) + added <= this.#capacityBytes;
  }

  #nextSequence(campaignId: string): number {
    const row = this.#db
      .query<{ sequence: number }, [string]>(
        'SELECT COALESCE(max(causal_sequence), 0) + 1 AS sequence FROM sync_pending_mutations WHERE campaign_id = ?',
      )
      .get(campaignId);
    return row?.sequence ?? 1;
  }

  #insertMutation(input: {
    readonly mutationId: string;
    readonly campaignId: string;
    readonly featureId: string;
    readonly tableName: string;
    readonly recordId: string;
    readonly operation: PendingMutation['operation'];
    readonly expectedVersion: number | null;
    readonly payload: string;
    readonly sequence: number;
    readonly recordedAt: string;
  }): void {
    this.#db
      .query<
        unknown,
        [string, string, string, string, string, string, number | null, string, number, string]
      >(
        `INSERT INTO sync_pending_mutations
         (mutation_id, campaign_id, feature_id, table_name, record_id, operation,
          expected_version, payload, causal_sequence, state, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(
        input.mutationId,
        input.campaignId,
        input.featureId,
        input.tableName,
        input.recordId,
        input.operation,
        input.expectedVersion,
        input.payload,
        input.sequence,
        input.recordedAt,
      );
  }
}

function toMutation(row: MutationRow): PendingMutation {
  return {
    mutationId: row.mutation_id,
    campaignId: row.campaign_id,
    featureId: row.feature_id,
    tableName: row.table_name,
    recordId: row.record_id,
    operation: row.operation,
    expectedVersion: row.expected_version,
    payload: parseJson<unknown>(row.payload),
    causalSequence: row.causal_sequence,
    state: row.state,
    attemptCount: row.attempt_count,
    recordedAt: row.recorded_at,
  };
}

function toConflict(row: ConflictRow): MutationConflict {
  return {
    kind: 'deferred_version_conflict',
    conflictId: row.conflict_id,
    mutationId: row.mutation_id,
    campaignId: row.campaign_id,
    featureId: row.feature_id,
    table: row.table_name,
    id: row.record_id,
    expectedVersion: row.expected_version,
    actualVersion: row.actual_version,
    submittedValue: parseJson<unknown>(row.submitted_value),
    currentValue: parseJson<unknown>(row.current_value),
    detectedAt: row.detected_at,
    resolutionState: row.resolution_state,
  };
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function versionedValue(
  value: unknown,
  id: string,
  campaignId: string,
  version: number,
  updatedAt: string,
): EntityEnvelope | undefined {
  if (
    value === null ||
    typeof value !== 'object' ||
    !('visibility' in value) ||
    value.visibility === null ||
    typeof value.visibility !== 'object'
  ) {
    return undefined;
  }
  return {
    ...value,
    id,
    campaignId,
    version,
    updatedAt,
  } as EntityEnvelope;
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortValue(item)]),
  );
}
