import {
  type AbstractPowerSyncDatabase,
  column,
  type PowerSyncBackendConnector,
  type PowerSyncConnectionOptions,
  PowerSyncDatabase,
  type SyncStatus as ProviderSyncStatus,
  Schema,
  SyncStreamConnectionMethod,
  Table,
  WASQLiteOpenFactory,
  WASQLiteVFS,
} from '@powersync/web';
import {
  type ConflictChannel,
  type EntityEnvelope,
  err,
  GM_ROLES,
  type Id,
  type ListOptions,
  ok,
  type ReplicaPurged,
  type ReplicaPurgeListener,
  type ReplicaPurgeReason,
  type RepositoryError,
  type Result,
  type SyncedRepository,
  type Version,
} from '@rpg/contracts';
import {
  AUDIT_CAMPAIGN_STREAM,
  AUDIT_PRIVATE_STREAM,
  AUDIT_SUBSCRIPTION_TTL_SECONDS,
  AuditReplicaStore,
  AuditWindowManager,
} from './audit-replica.ts';
import { Channel } from './channel.ts';
import type {
  CachedMembership,
  MembershipReconcile,
  MutationBatch,
  MutationConflict,
  MutationOutcome,
  MutationState,
  PendingMutation,
} from './model.ts';
import {
  ReplicaAccessReconciler,
  type ReplicaAccessStore,
  type ReplicaPurgeResult,
  type ReplicaPurger,
} from './replica-access.ts';
import { isValidMutationAudit, type MutationAuditPayload } from './schemas.ts';
import { SyncStatusStore } from './status.ts';

export type BrowserStorageBackend = 'opfs' | 'indexeddb';
export type SyncFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Fresh table definitions (a PowerSync `Table` belongs to one `Schema`). */
function replicaTables() {
  return {
    campaigns: new Table({
      name: column.text,
      description: column.text,
      game_mode: column.text,
      created_by: column.text,
      version: column.integer,
      created_at: column.text,
      updated_at: column.text,
      deleted_at: column.text,
    }),
    campaign_settings: new Table(
      {
        campaign_id: column.text,
        namespace: column.text,
        value: column.text,
        member_visible: column.integer,
        version: column.integer,
        updated_at: column.text,
        updated_by: column.text,
        deleted_at: column.text,
      },
      { indexes: { campaign: ['campaign_id'] } },
    ),
    sync_long_text_holds: new Table(
      {
        campaign_id: column.text,
        resource_class: column.text,
        record_id: column.text,
        field_path: column.text,
        holder_user_id: column.text,
        acquired_at: column.text,
        renewed_at: column.text,
        expires_at: column.text,
        version: column.integer,
      },
      { indexes: { field: ['campaign_id', 'resource_class', 'record_id', 'field_path'] } },
    ),
    /**
     * Current user's membership cache (stream `current_user_memberships`): feature 01 `_db.md`
     * fields only. Tombstones (`removed_at`) arrive here and drive replica purge.
     */
    identity_campaign_memberships: new Table(
      {
        campaign_id: column.text,
        user_id: column.text,
        role: column.text,
        version: column.integer,
        updated_at: column.text,
        removed_at: column.text,
      },
      { indexes: { campaign: ['campaign_id'] } },
    ),
    /**
     * Reconciled membership cache (feature 01 rule, `ReplicaAccessReconciler`): survives a
     * provider-side removal of the replicated row and keeps revocation tombstones.
     */
    sync_membership_cache: new Table(
      {
        campaign_id: column.text,
        user_id: column.text,
        role: column.text,
        version: column.integer,
        updated_at: column.text,
        removed_at: column.text,
      },
      { localOnly: true },
    ),
    sync_campaign_state: new Table(
      {
        campaign_id: column.text,
        replica_state: column.text,
        last_server_cursor: column.text,
        last_sync_at: column.text,
        last_error_code: column.text,
        replica_id: column.text,
      },
      { localOnly: true, indexes: { campaign: ['campaign_id'] } },
    ),
    sync_pending_mutations: new Table(
      {
        campaign_id: column.text,
        feature_id: column.text,
        table_name: column.text,
        record_id: column.text,
        operation: column.text,
        expected_version: column.integer,
        payload: column.text,
        causal_sequence: column.integer,
        state: column.text,
        attempt_count: column.integer,
        next_attempt_at: column.text,
        recorded_at: column.text,
        terminal_at: column.text,
      },
      {
        localOnly: true,
        indexes: { campaign_sequence: ['campaign_id', 'causal_sequence'] },
      },
    ),
    sync_conflicts: new Table(
      {
        mutation_id: column.text,
        campaign_id: column.text,
        feature_id: column.text,
        table_name: column.text,
        record_id: column.text,
        expected_version: column.integer,
        actual_version: column.integer,
        submitted_value: column.text,
        current_value: column.text,
        detected_at: column.text,
        resolution_state: column.text,
        resolver_user_id: column.text,
        resolved_at: column.text,
      },
      { localOnly: true, indexes: { campaign: ['campaign_id', 'resolution_state'] } },
    ),
    /** Feature 06 task 04: campaign-visible audit (stream `campaign_audit`, windowed). */
    audit_campaign_events: auditTable(),
    /** Local-only audit window per campaign: subscribed months and partial-history marker. */
    sync_audit_window: new Table(
      {
        campaign_id: column.text,
        months: column.text,
        partial: column.integer,
        bytes: column.integer,
        private_subscribed: column.integer,
        planned_at: column.text,
      },
      { localOnly: true },
    ),
  };
}

/** Audit rows as the approved projection replicates them (no sequence, snapshot, or origin). */
function auditTable(): Table {
  return new Table(
    {
      campaign_id: column.text,
      session_id: column.text,
      actor_user_id: column.text,
      actor_role: column.text,
      action: column.text,
      target_type: column.text,
      target_id: column.text,
      before_value: column.text,
      after_value: column.text,
      client_recorded_at: column.text,
      accepted_at: column.text,
      renderer_version: column.integer,
    },
    { indexes: { campaign_accepted: ['campaign_id', 'accepted_at'] } },
  );
}

/**
 * A feature-owned replica table in provider-neutral column terms (feature 16: `@rpg/content`
 * `CONTENT_REPLICA_TABLES`). The composition root passes them in, so this package never names a
 * feature's table. Columns are the approved stream projection without `id`.
 */
export interface FeatureReplicaTable {
  readonly columns: Readonly<Record<string, 'text' | 'integer' | 'real'>>;
  readonly indexes?: Readonly<Record<string, readonly string[]>>;
}
export type FeatureReplicaTables = Readonly<Record<string, FeatureReplicaTable>>;

function featureTables(tables: FeatureReplicaTables, reserved: readonly string[]) {
  const built: Record<string, Table> = {};
  for (const [name, definition] of Object.entries(tables)) {
    // A feature table never replaces a platform table.
    if (reserved.includes(name)) throw new Error(`replica table name reserved: ${name}`);
    built[name] = new Table(
      Object.fromEntries(
        Object.entries(definition.columns).map(([key, type]) => [key, column[type]]),
      ),
      definition.indexes === undefined
        ? {}
        : {
            indexes: Object.fromEntries(
              Object.entries(definition.indexes).map(([key, columns]) => [key, [...columns]]),
            ),
          },
    );
  }
  return built;
}

/**
 * The replica schema. `audit_private_events` exists only while the user holds a GM role in some
 * campaign (feature 06 `_db.md`: players do not create the private table or subscription).
 * `tables` adds the feature-owned replicated tables (feature 16 task 04).
 */
export function replicaSchema(options: {
  readonly privateAudit: boolean;
  readonly tables?: FeatureReplicaTables;
}): Schema {
  const platform = replicaTables();
  return new Schema({
    ...platform,
    ...(options.privateAudit ? { audit_private_events: auditTable() } : {}),
    ...featureTables(options.tables ?? {}, [...Object.keys(platform), 'audit_private_events']),
  });
}

export const SyncBookkeepingSchema = replicaSchema({ privateAudit: false });

export function selectBrowserStorageBackend(input: {
  readonly force?: BrowserStorageBackend;
  readonly opfsAvailable?: boolean;
}): BrowserStorageBackend {
  if (input.force !== undefined) return input.force;
  return input.opfsAvailable ? 'opfs' : 'indexeddb';
}

export function browserSupportsOpfs(): boolean {
  return (
    globalThis.crossOriginIsolated === true &&
    typeof globalThis.SharedArrayBuffer !== 'undefined' &&
    typeof globalThis.navigator?.storage?.getDirectory === 'function'
  );
}

export function createBrowserReplicaDatabase(options: {
  readonly filename: string;
  readonly schema?: Schema;
  readonly forceBackend?: BrowserStorageBackend;
  readonly assetBaseUrl?: string;
}): { readonly database: PowerSyncDatabase; readonly backend: BrowserStorageBackend } {
  const backend = selectBrowserStorageBackend({
    ...(options.forceBackend === undefined ? {} : { force: options.forceBackend }),
    opfsAvailable: browserSupportsOpfs(),
  });
  const assetBase = options.assetBaseUrl ?? '/sync-assets/powersync-1.39.1';
  const database = new PowerSyncDatabase({
    schema: options.schema ?? SyncBookkeepingSchema,
    database: new WASQLiteOpenFactory({
      dbFilename: options.filename,
      vfs: backend === 'opfs' ? WASQLiteVFS.OPFSCoopSyncVFS : WASQLiteVFS.IDBBatchAtomicVFS,
      worker: `${assetBase}/WASQLiteDB.umd.js`,
      flags: { enableMultiTabs: true, useWebWorker: true },
    }),
    sync: { worker: `${assetBase}/SharedSyncImplementation.umd.js` },
    flags: { enableMultiTabs: true, useWebWorker: true },
  });
  return { database, backend };
}

/**
 * Browser replica bookkeeping over the PowerSync SQLite worker (feature 03 tasks 04/07/08).
 *
 * Provider-managed tables (`campaigns`, `campaign_settings`, `sync_long_text_holds`,
 * `identity_campaign_memberships`) are written only by the provider, or by a local optimistic
 * write recorded together with its queued mutation. Application bookkeeping lives in local-only
 * tables and is dropped here on revocation. A provider-managed row of a revoked campaign is
 * removed by the provider (the stream joins the active membership); a device that cannot reach
 * the provider any more clears provider data with `disconnectAndClear` (`BrowserSyncSession`).
 */

/** The subset of PowerSync's database this store needs (keeps it testable without a worker). */
export interface BrowserSqlTransaction {
  execute(sql: string, parameters?: unknown[]): Promise<unknown>;
  getAll<T>(sql: string, parameters?: unknown[]): Promise<T[]>;
  getOptional<T>(sql: string, parameters?: unknown[]): Promise<T | null>;
}

export interface BrowserSqlDatabase extends BrowserSqlTransaction {
  writeTransaction<T>(callback: (tx: BrowserSqlTransaction) => Promise<T>): Promise<T>;
}

interface MembershipRow {
  readonly campaign_id: string;
  readonly user_id: string;
  readonly role: CachedMembership['role'];
  readonly version: number;
  readonly updated_at: string;
  readonly removed_at: string | null;
}

interface MutationRow {
  readonly id: string;
  readonly campaign_id: string;
  readonly feature_id: string;
  readonly table_name: string;
  readonly record_id: string;
  readonly operation: PendingMutation['operation'];
  readonly expected_version: number | null;
  readonly payload: string | null;
  readonly causal_sequence: number;
  readonly state: PendingMutation['state'];
  readonly attempt_count: number;
  readonly recorded_at: string;
}

/** Replica tables a local optimistic write may touch (provider-managed, campaign-scoped). */
const WRITABLE_TABLES = new Set(['campaigns', 'campaign_settings']);
const COLUMN = /^[a-z][a-z0-9_]*$/;

export interface BrowserLocalWrite {
  readonly mutationId: string;
  readonly campaignId: string;
  readonly featureId: string;
  /** Replica table; also the registered applier's table name. */
  readonly tableName: string;
  readonly recordId: string;
  /** `tombstone` writes its row like an update (`deleted_at` set) and queues a tombstone. */
  readonly operation: 'insert' | 'update' | 'tombstone';
  readonly expectedVersion: number | null;
  /**
   * Feature tables (`SyncedRepository`): compare the local row's `version` with
   * `expectedVersion` inside the write transaction (null: the row must not exist), so a stale
   * local edit is refused synchronously and nothing is written.
   */
  readonly checkLocalVersion?: boolean;
  /** Upload payload (the registered applier's shape). */
  readonly payload: unknown;
  /** Columns written to the local replica row so the value is readable immediately. */
  readonly row: Readonly<Record<string, string | number | null>>;
  readonly audit?: MutationAuditPayload;
  readonly recordedAt: string;
}

export interface ReplicaCampaignRow {
  readonly id: string;
  readonly name: string;
  readonly version: number;
  readonly deleted_at: string | null;
}

export interface ReplicaSettingRow {
  readonly id: string;
  readonly campaign_id: string;
  readonly namespace: string;
  readonly member_visible: number;
  readonly version: number;
  readonly deleted_at: string | null;
}

/** Outcome of a local write with `checkLocalVersion`. */
export type BrowserRecordResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'not_found' }
  | { readonly ok: false; readonly reason: 'version_conflict'; readonly actualVersion: number };

export interface BrowserConflictResolution {
  readonly conflictId: string;
  readonly resolverUserId: string;
  readonly resolvedAt: string;
  /** `resubmit`: the new local write (row + queued mutation) recorded in the same transaction. */
  readonly resubmit?: BrowserLocalWrite;
}

export class BrowserReplicaStore implements ReplicaAccessStore {
  readonly #writable: ReadonlySet<string>;
  readonly #featureTables: ReadonlySet<string>;
  readonly #conflicts = new Channel<MutationConflict>();

  /**
   * `featureTables`: feature-owned replica tables (feature 16 task 11) that local optimistic
   * writes and feature repositories may read and write, beside `campaigns`/`campaign_settings`.
   */
  constructor(
    private readonly db: BrowserSqlDatabase,
    options: { readonly featureTables?: readonly string[] } = {},
  ) {
    const featureTables = (options.featureTables ?? []).filter((name) => COLUMN.test(name));
    this.#featureTables = new Set(featureTables);
    this.#writable = new Set([...WRITABLE_TABLES, ...featureTables]);
  }

  /** Conflicts raised by uploads (`applyOutcomes`), for feature `ConflictChannel`s. */
  get conflictEvents(): Pick<Channel<MutationConflict>, 'subscribe'> {
    return this.#conflicts;
  }

  #featureTable(tableName: string): string {
    if (!this.#featureTables.has(tableName)) throw new Error('unregistered_replica_table');
    return tableName;
  }

  /** One row of a feature table (live or tombstoned), as the provider or a local write left it. */
  featureRow(tableName: string, id: string): Promise<Readonly<Record<string, unknown>> | null> {
    return this.db.getOptional<Record<string, unknown>>(
      `SELECT * FROM ${this.#featureTable(tableName)} WHERE id = ?`,
      [id],
    );
  }

  /** Every row of a feature table for one campaign (live and tombstoned), ordered by id. */
  featureRows(tableName: string, campaignId: string): Promise<Readonly<Record<string, unknown>>[]> {
    return this.db.getAll<Record<string, unknown>>(
      `SELECT * FROM ${this.#featureTable(tableName)} WHERE campaign_id = ? ORDER BY id`,
      [campaignId],
    );
  }

  /** The replicated long-text hold on one field, if any (feature 03 holds stream). */
  async longTextHold(field: {
    readonly campaignId: string;
    readonly resourceClass: string;
    readonly recordId: string;
    readonly fieldPath: string;
  }): Promise<
    | {
        readonly holderUserId: string;
        readonly version: number;
        readonly expiresAt: string;
      }
    | undefined
  > {
    const row = await this.db.getOptional<{
      holder_user_id: string;
      version: number;
      expires_at: string;
    }>(
      `SELECT holder_user_id, version, expires_at FROM sync_long_text_holds
       WHERE campaign_id = ? AND resource_class = ? AND record_id = ? AND field_path = ?`,
      [field.campaignId, field.resourceClass, field.recordId, field.fieldPath],
    );
    return row === null
      ? undefined
      : {
          holderUserId: row.holder_user_id,
          version: Number(row.version),
          expiresAt: row.expires_at,
        };
  }

  /**
   * State of the newest queued mutation of one record (`undefined`: none). A held long-text
   * write keeps its hold until this leaves `pending`/`uploading` (feature 16 task 12).
   */
  async latestMutationState(
    campaignId: string,
    recordId: string,
  ): Promise<MutationState | undefined> {
    const row = await this.db.getOptional<{ state: MutationState }>(
      `SELECT state FROM sync_pending_mutations WHERE campaign_id = ? AND record_id = ?
       ORDER BY causal_sequence DESC LIMIT 1`,
      [campaignId, recordId],
    );
    return row?.state;
  }

  /** Conflicts of one campaign awaiting a choice (unresolved or deferred), oldest first. */
  async conflicts(campaignId: string): Promise<MutationConflict[]> {
    const rows = await this.db.getAll<ConflictRow>(
      `SELECT id, mutation_id, campaign_id, feature_id, table_name, record_id, expected_version,
              actual_version, submitted_value, current_value, detected_at, resolution_state
       FROM sync_conflicts WHERE campaign_id = ? AND resolution_state != 'resolved'
       ORDER BY detected_at, id`,
      [campaignId],
    );
    return rows.map(toConflict);
  }

  async conflict(conflictId: string): Promise<MutationConflict | undefined> {
    const row = await this.db.getOptional<ConflictRow>(
      `SELECT id, mutation_id, campaign_id, feature_id, table_name, record_id, expected_version,
              actual_version, submitted_value, current_value, detected_at, resolution_state
       FROM sync_conflicts WHERE id = ?`,
      [conflictId],
    );
    return row === null ? undefined : toConflict(row);
  }

  async deferConflict(conflictId: string): Promise<void> {
    await this.db.execute(
      `UPDATE sync_conflicts SET resolution_state = 'deferred'
       WHERE id = ? AND resolution_state = 'unresolved'`,
      [conflictId],
    );
  }

  /**
   * Resolves a conflict (feature 03 FR-009, browser counterpart of `ConflictResolutionService`):
   * the conflict becomes `resolved`, the conflicted mutation leaves the pending count, and a
   * `resubmit` records its new write (replica row + queued mutation) in the same transaction.
   * Keeping the authority needs no local write: the provider delivers the authority row once the
   * upload queue is complete. Returns false when the conflict is unknown or already resolved.
   */
  async resolveConflict(input: BrowserConflictResolution): Promise<boolean> {
    if (input.resubmit !== undefined) this.#checkWrite(input.resubmit);
    return this.db.writeTransaction(async (tx) => {
      const row = await tx.getOptional<{ mutation_id: string; resolution_state: string }>(
        'SELECT mutation_id, resolution_state FROM sync_conflicts WHERE id = ?',
        [input.conflictId],
      );
      if (row === null || row.resolution_state === 'resolved') return false;
      await tx.execute(
        `UPDATE sync_conflicts SET resolution_state = 'resolved', resolver_user_id = ?,
                resolved_at = ? WHERE id = ?`,
        [input.resolverUserId, input.resolvedAt, input.conflictId],
      );
      await tx.execute(
        'UPDATE sync_pending_mutations SET payload = NULL, terminal_at = ? WHERE id = ?',
        [input.resolvedAt, row.mutation_id],
      );
      if (input.resubmit !== undefined) await recordWithin(tx, input.resubmit);
      return true;
    });
  }

  async cachedMembership(campaignId: string): Promise<CachedMembership | undefined> {
    const row = await this.db.getOptional<MembershipRow>(
      `SELECT campaign_id, user_id, role, version, updated_at, removed_at
       FROM sync_membership_cache WHERE id = ?`,
      [campaignId],
    );
    return row === null ? undefined : toMembership(row);
  }

  async cachedMemberships(): Promise<CachedMembership[]> {
    const rows = await this.db.getAll<MembershipRow>(
      `SELECT campaign_id, user_id, role, version, updated_at, removed_at
       FROM sync_membership_cache ORDER BY campaign_id`,
    );
    return rows.map(toMembership);
  }

  async putMembership(row: CachedMembership): Promise<void> {
    await this.db.execute(
      `INSERT OR REPLACE INTO sync_membership_cache
         (id, campaign_id, user_id, role, version, updated_at, removed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        row.campaignId,
        row.campaignId,
        row.userId,
        row.role,
        row.version,
        row.updatedAt,
        row.removedAt,
      ],
    );
  }

  async deleteMembership(campaignId?: string): Promise<void> {
    if (campaignId === undefined) await this.db.execute('DELETE FROM sync_membership_cache');
    else await this.db.execute('DELETE FROM sync_membership_cache WHERE id = ?', [campaignId]);
  }

  /** Provider-delivered membership rows of the current user (stream `current_user_memberships`). */
  async replicatedMemberships(): Promise<CachedMembership[]> {
    const rows = await this.db.getAll<MembershipRow>(
      `SELECT campaign_id, user_id, role, version, updated_at, removed_at
       FROM identity_campaign_memberships ORDER BY campaign_id`,
    );
    return rows.map(toMembership);
  }

  /** Local campaign rows (live and tombstoned), as the provider or a local write left them. */
  campaigns(): Promise<ReplicaCampaignRow[]> {
    return this.db.getAll<ReplicaCampaignRow>(
      'SELECT id, name, version, deleted_at FROM campaigns ORDER BY id',
    );
  }

  /** Creation time of the replicated campaign row (audit history starts there). */
  async campaignCreatedAt(campaignId: string): Promise<string | undefined> {
    const row = await this.db.getOptional<{ created_at: string | null }>(
      'SELECT created_at FROM campaigns WHERE id = ?',
      [campaignId],
    );
    return row?.created_at ?? undefined;
  }

  /** Local campaign settings rows (live and tombstoned). */
  settings(): Promise<ReplicaSettingRow[]> {
    return this.db.getAll<ReplicaSettingRow>(
      `SELECT id, campaign_id, namespace, member_visible, version, deleted_at
       FROM campaign_settings ORDER BY id`,
    );
  }

  async hasPendingCreation(campaignId: string): Promise<boolean> {
    const row = await this.db.getOptional<{ count: number }>(
      `SELECT count(*) AS count FROM sync_pending_mutations
       WHERE campaign_id = ? AND record_id = campaign_id AND operation = 'insert'
         AND expected_version IS NULL AND state IN ('pending','uploading')`,
      [campaignId],
    );
    return (row?.count ?? 0) > 0;
  }

  /** Stable replica identity for one campaign on this device; created on first use. */
  async replicaId(campaignId: string): Promise<string> {
    return this.db.writeTransaction((tx) => ensureReplicaId(tx, campaignId));
  }

  async knownReplicaId(campaignId: string): Promise<string | undefined> {
    const row = await this.db.getOptional<{ replica_id: string | null }>(
      'SELECT replica_id FROM sync_campaign_state WHERE id = ?',
      [campaignId],
    );
    return row?.replica_id ?? undefined;
  }

  /** Every campaign with a local trace: replica rows, queue, conflicts, state, or cache. */
  async campaignIds(): Promise<string[]> {
    const rows = await this.db.getAll<{ campaign_id: string }>(
      `SELECT id AS campaign_id FROM campaigns
       UNION SELECT campaign_id FROM sync_pending_mutations
       UNION SELECT campaign_id FROM sync_conflicts
       UNION SELECT campaign_id FROM sync_campaign_state
       UNION SELECT campaign_id FROM sync_membership_cache
       UNION SELECT campaign_id FROM sync_audit_window
       ORDER BY campaign_id`,
    );
    return rows.map((row) => row.campaign_id);
  }

  /**
   * Same rule as `SqliteReplicaStore.pendingCount`: every confirmed mutation that is not accepted
   * (queued, uploading, conflicted, rejected) and not superseded by a resolved conflict.
   */
  async pendingCount(): Promise<number> {
    const row = await this.db.getOptional<{ count: number }>(
      `SELECT count(*) AS count FROM sync_pending_mutations AS mutation
       WHERE state != 'accepted'
         AND NOT EXISTS (
           SELECT 1 FROM sync_conflicts AS conflict
           WHERE conflict.mutation_id = mutation.id AND conflict.resolution_state = 'resolved'
         )`,
    );
    return row?.count ?? 0;
  }

  /** `pendingCount` for one campaign, unresolved conflicts included. */
  async campaignPendingCount(campaignId: string): Promise<number> {
    const row = await this.db.getOptional<{ count: number }>(
      `SELECT count(*) AS count FROM sync_pending_mutations AS mutation
       WHERE mutation.campaign_id = ? AND state != 'accepted'
         AND NOT EXISTS (
           SELECT 1 FROM sync_conflicts AS conflict
           WHERE conflict.mutation_id = mutation.id AND conflict.resolution_state = 'resolved'
         )`,
      [campaignId],
    );
    return row?.count ?? 0;
  }

  /** Conflicts awaiting a user choice plus terminally rejected mutations. */
  async unresolvedCount(): Promise<number> {
    const row = await this.db.getOptional<{ count: number }>(
      `SELECT
         (SELECT count(*) FROM sync_conflicts WHERE resolution_state != 'resolved')
         + (SELECT count(*) FROM sync_pending_mutations WHERE state = 'rejected') AS count`,
    );
    return row?.count ?? 0;
  }

  /**
   * Local-first write: the replica row and its queued mutation commit in one SQLite transaction,
   * so the value is readable immediately and the mutation survives restart.
   */
  async record(input: BrowserLocalWrite): Promise<BrowserRecordResult> {
    this.#checkWrite(input);
    return this.db.writeTransaction(async (tx) => {
      if (input.checkLocalVersion === true) {
        const current = await tx.getOptional<{ version: number }>(
          `SELECT version FROM ${input.tableName} WHERE id = ?`,
          [input.recordId],
        );
        if (current === null && input.expectedVersion !== null) {
          return { ok: false, reason: 'not_found' } as const;
        }
        if (current !== null && Number(current.version) !== input.expectedVersion) {
          return {
            ok: false,
            reason: 'version_conflict',
            actualVersion: Number(current.version),
          } as const;
        }
      }
      await recordWithin(tx, input);
      return { ok: true } as const;
    });
  }

  #checkWrite(input: BrowserLocalWrite): void {
    if (!this.#writable.has(input.tableName)) throw new Error('unregistered_replica_table');
    const columns = Object.keys(input.row);
    if (columns.length === 0 || columns.some((column) => !COLUMN.test(column) || column === 'id')) {
      throw new Error('invalid_replica_columns');
    }
  }

  /**
   * Next ordered batch of the earliest campaign with queued work (causal order, ≤ 100), marked
   * `uploading`. An interrupted upload keeps its `uploading` rows, so a retry resends the same
   * mutation ids (the authority's receipts make that idempotent).
   */
  async nextBatch(): Promise<MutationBatch | undefined> {
    return this.db.writeTransaction(async (tx) => {
      const first = await tx.getOptional<{ campaign_id: string }>(
        `SELECT campaign_id FROM sync_pending_mutations
         WHERE state IN ('pending','uploading')
         ORDER BY recorded_at, causal_sequence LIMIT 1`,
      );
      if (first === null) return undefined;
      const rows = await tx.getAll<MutationRow>(
        `SELECT id, campaign_id, feature_id, table_name, record_id, operation, expected_version,
                payload, causal_sequence, state, attempt_count, recorded_at
         FROM sync_pending_mutations
         WHERE campaign_id = ? AND state IN ('pending','uploading')
         ORDER BY causal_sequence LIMIT 100`,
        [first.campaign_id],
      );
      await tx.execute(
        `UPDATE sync_pending_mutations
         SET state = 'uploading', attempt_count = attempt_count + 1
         WHERE campaign_id = ? AND state IN ('pending','uploading') AND causal_sequence <= ?`,
        [first.campaign_id, rows.at(-1)?.causal_sequence ?? 0],
      );
      return {
        campaignId: first.campaign_id,
        replicaId: await ensureReplicaId(tx, first.campaign_id),
        mutations: rows.map(toPendingMutation),
      };
    });
  }

  /**
   * Accepted: compact the payload. Retryable error: back to `pending`. Terminal error:
   * `rejected` (still counted, reported as unresolved). Conflict: durable conflict row with both
   * values; the mutation stays counted until the user resolves it.
   */
  async applyOutcomes(outcomes: readonly MutationOutcome[], at: string): Promise<void> {
    const raised: MutationConflict[] = [];
    await this.db.writeTransaction(async (tx) => {
      for (const outcome of outcomes) {
        const mutation = await tx.getOptional<MutationRow>(
          `SELECT id, campaign_id, feature_id, table_name, record_id, operation, expected_version,
                  payload, causal_sequence, state, attempt_count, recorded_at
           FROM sync_pending_mutations WHERE id = ?`,
          [outcome.mutationId],
        );
        // Dropped by a purge, or already terminal: a late outcome changes nothing.
        if (mutation === null || mutation.state === 'accepted') continue;
        if (outcome.status === 'accepted') {
          await tx.execute(
            `UPDATE sync_pending_mutations SET state = 'accepted', payload = NULL, terminal_at = ?
             WHERE id = ?`,
            [at, outcome.mutationId],
          );
          await tx.execute(
            `UPDATE sync_campaign_state
             SET last_server_cursor = ?, last_sync_at = ?, last_error_code = NULL WHERE id = ?`,
            [outcome.serverCursor, at, mutation.campaign_id],
          );
          continue;
        }
        if (outcome.status === 'error') {
          await tx.execute(
            `UPDATE sync_pending_mutations SET state = ?, next_attempt_at = ?, terminal_at = ?
             WHERE id = ?`,
            [
              outcome.retryable ? 'pending' : 'rejected',
              outcome.retryable ? at : null,
              outcome.retryable ? null : at,
              outcome.mutationId,
            ],
          );
          continue;
        }
        const conflictId = crypto.randomUUID();
        const submitted = parsePayload(mutation.payload).value ?? null;
        await tx.execute(
          `INSERT INTO sync_conflicts
             (id, mutation_id, campaign_id, feature_id, table_name, record_id, expected_version,
              actual_version, submitted_value, current_value, detected_at, resolution_state)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unresolved')`,
          [
            conflictId,
            mutation.id,
            mutation.campaign_id,
            mutation.feature_id,
            mutation.table_name,
            mutation.record_id,
            outcome.expectedVersion,
            outcome.actualVersion,
            JSON.stringify(submitted),
            JSON.stringify(outcome.currentValue ?? null),
            at,
          ],
        );
        await tx.execute("UPDATE sync_pending_mutations SET state = 'conflicted' WHERE id = ?", [
          mutation.id,
        ]);
        raised.push({
          kind: 'deferred_version_conflict',
          conflictId,
          mutationId: mutation.id,
          campaignId: mutation.campaign_id,
          featureId: mutation.feature_id,
          table: mutation.table_name,
          id: mutation.record_id,
          expectedVersion: outcome.expectedVersion,
          actualVersion: outcome.actualVersion,
          submittedValue: submitted,
          currentValue: outcome.currentValue ?? null,
          detectedAt: at,
          resolutionState: 'unresolved',
        });
      }
    });
    for (const conflict of raised) this.#conflicts.emit(conflict);
  }

  /** Drops every local-only trace of one campaign (queue, conflicts, replica state). */
  async dropCampaign(campaignId: string): Promise<void> {
    await this.db.writeTransaction(async (tx) => {
      for (const table of ['sync_conflicts', 'sync_pending_mutations']) {
        await tx.execute(`DELETE FROM ${table} WHERE campaign_id = ?`, [campaignId]);
      }
      await tx.execute('DELETE FROM sync_campaign_state WHERE id = ?', [campaignId]);
      await tx.execute('DELETE FROM sync_audit_window WHERE id = ?', [campaignId]);
    });
  }
}

/**
 * Browser counterpart of `ReplicaManager`: drops local-only state before listeners run and
 * keeps the cached membership tombstone on `access_revoked`, so a stale delivery cannot restore
 * access.
 */
export class BrowserReplicaManager implements ReplicaPurger {
  /** Runs first on every purge, while local state is still readable (audit windows). */
  beforePurge?: (campaignId: string) => Promise<void>;

  constructor(
    private readonly store: BrowserReplicaStore,
    private readonly status: SyncStatusStore,
    private readonly listeners: readonly ReplicaPurgeListener[] = [],
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async purge(campaignId: string, reason: ReplicaPurgeReason): Promise<ReplicaPurgeResult> {
    await this.beforePurge?.(campaignId).catch(() => undefined);
    const replicaId = await this.store.replicaId(campaignId);
    const purgedAt = timestamp(this.clock());
    await this.store.dropCampaign(campaignId);
    const cached = await this.store.cachedMembership(campaignId);
    if (reason !== 'access_revoked') await this.store.deleteMembership(campaignId);
    else if (cached !== undefined && cached.removedAt === null) {
      await this.store.putMembership({ ...cached, removedAt: purgedAt });
    }
    this.status.setPendingCount(await this.store.pendingCount());
    this.status.setUnresolvedConflicts(await this.store.unresolvedCount());
    const event: ReplicaPurged = { campaignId, replicaId, reason, purgedAt };
    const settled = await Promise.allSettled(
      this.listeners.map((listener) => listener.replicaPurged(event)),
    );
    // `replicaId()` recreated a state row for the event; the replica is gone.
    await this.store.dropCampaign(campaignId);
    return {
      event,
      listenerErrors: settled.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : [],
      ),
    };
  }

  async signOut(): Promise<readonly ReplicaPurgeResult[]> {
    const results: ReplicaPurgeResult[] = [];
    for (const campaignId of await this.store.campaignIds()) {
      results.push(await this.purge(campaignId, 'signed_out'));
    }
    await this.store.deleteMembership();
    return results;
  }
}

/** Writes the replica row and queues its mutation on an open transaction (checked by the caller). */
async function recordWithin(tx: BrowserSqlTransaction, input: BrowserLocalWrite): Promise<void> {
  const columns = Object.keys(input.row);
  const values = columns.map((column) => input.row[column] ?? null);
  if (input.operation === 'insert') {
    await tx.execute(
      `INSERT INTO ${input.tableName} (id, ${columns.join(', ')})
       VALUES (?, ${columns.map(() => '?').join(', ')})`,
      [input.recordId, ...values],
    );
  } else {
    await tx.execute(
      `UPDATE ${input.tableName} SET ${columns.map((column) => `${column} = ?`).join(', ')}
       WHERE id = ?`,
      [...values, input.recordId],
    );
  }
  const sequence = await tx.getOptional<{ next: number }>(
    `SELECT coalesce(max(causal_sequence), 0) + 1 AS next FROM sync_pending_mutations
     WHERE campaign_id = ?`,
    [input.campaignId],
  );
  await tx.execute(
    `INSERT INTO sync_pending_mutations
       (id, campaign_id, feature_id, table_name, record_id, operation, expected_version,
        payload, causal_sequence, state, attempt_count, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?)`,
    [
      input.mutationId,
      input.campaignId,
      input.featureId,
      input.tableName,
      input.recordId,
      input.operation,
      input.expectedVersion,
      JSON.stringify({
        value: input.payload,
        ...(input.audit === undefined ? {} : { audit: input.audit }),
      }),
      sequence?.next ?? 1,
      input.recordedAt,
    ],
  );
}

interface ConflictRow {
  readonly id: string;
  readonly mutation_id: string;
  readonly campaign_id: string;
  readonly feature_id: string;
  readonly table_name: string;
  readonly record_id: string;
  readonly expected_version: number;
  readonly actual_version: number;
  readonly submitted_value: string | null;
  readonly current_value: string | null;
  readonly detected_at: string;
  readonly resolution_state: MutationConflict['resolutionState'];
}

function parseStored(value: string | null): unknown {
  if (value === null) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function toConflict(row: ConflictRow): MutationConflict {
  return {
    kind: 'deferred_version_conflict',
    conflictId: row.id,
    mutationId: row.mutation_id,
    campaignId: row.campaign_id,
    featureId: row.feature_id,
    table: row.table_name,
    id: row.record_id,
    expectedVersion: Number(row.expected_version),
    actualVersion: Number(row.actual_version),
    submittedValue: parseStored(row.submitted_value),
    currentValue: parseStored(row.current_value),
    detectedAt: row.detected_at,
    resolutionState: row.resolution_state,
  };
}

/** Feature-owned row mapping: record ↔ replica columns (the feature validates on read). */
export interface BrowserRecordCodec<T> {
  /** Replica columns without `id`. */
  toRow(record: T): Readonly<Record<string, string | number | null>>;
  /** A malformed row is `undefined` (never guessed). */
  fromRow(row: Readonly<Record<string, unknown>>): T | undefined;
  /**
   * The value a `resubmit` sends after a conflict, from the submitted value and the authority's
   * current value (e.g. keep authority-owned fields). Defaults to the submitted value.
   */
  resubmitValue?(submitted: unknown, current: unknown): unknown;
}

/**
 * Feature 03 `SyncedRepository` over one feature-owned browser replica table (feature 16 task 11):
 * reads the local replica (only what the device may read), and every write is the replica row plus
 * its queued mutation with an audit envelope, in one SQLite transaction, with a synchronous local
 * version check. Deferred conflicts arrive on `conflicts` after upload.
 */
export class BrowserSyncedRepository<T extends EntityEnvelope> implements SyncedRepository<T> {
  readonly conflicts: ConflictChannel;

  constructor(
    private readonly store: BrowserReplicaStore,
    private readonly options: {
      readonly tableName: string;
      readonly featureId: string;
      readonly userId: string;
      readonly campaignId: string;
      readonly codec: BrowserRecordCodec<T>;
      /**
       * `false` queues no audit envelope, for a table whose record is its own history (feature 09
       * rolls). Default: every write carries one.
       */
      readonly audited?: boolean;
      /** Called after each local write (pending counts). */
      readonly written?: () => void;
      readonly clock?: () => Date;
      readonly createId?: () => string;
    },
  ) {
    this.conflicts = {
      subscribe: (listener) =>
        store.conflictEvents.subscribe((conflict) => {
          if (conflict.table === options.tableName) listener(conflict);
        }),
    };
  }

  async get(id: Id): Promise<Result<T, RepositoryError>> {
    const row = await this.store.featureRow(this.options.tableName, id);
    const record = row === null ? undefined : this.options.codec.fromRow(row);
    return record === undefined ? err({ kind: 'not_found', id }) : ok(record);
  }

  async list(campaignId: Id, options: ListOptions = {}): Promise<Result<T[], RepositoryError>> {
    const rows = await this.store.featureRows(this.options.tableName, campaignId);
    const records = rows
      .map((row) => this.options.codec.fromRow(row))
      .filter((record): record is T => record !== undefined)
      .filter((record) => options.includeDeleted === true || record.deletedAt === undefined);
    const offset = options.offset ?? 0;
    return ok(
      options.limit === undefined
        ? records.slice(offset)
        : records.slice(offset, offset + options.limit),
    );
  }

  async upsert(value: T, expectedVersion: Version | null): Promise<Result<T, RepositoryError>> {
    if (value.campaignId !== this.options.campaignId)
      return err({ kind: 'not_found', id: value.id });
    const now = timestamp(this.#clock());
    const stored = { ...value, version: expectedVersion === null ? 1 : expectedVersion + 1 } as T;
    const written = await this.#write({
      operation: expectedVersion === null ? 'insert' : 'update',
      value: stored,
      expectedVersion,
      audit: {
        campaignId: value.campaignId,
        action: `${this.options.featureId}.${expectedVersion === null ? 'created' : 'updated'}`,
        targetType: this.options.tableName,
        targetId: value.id,
        after: { version: stored.version },
        at: now,
        private: value.visibility.mode === 'gm_only',
      },
    });
    return written.ok ? ok(stripTransport(stored)) : written;
  }

  async softDelete(id: Id, expectedVersion: Version): Promise<Result<void, RepositoryError>> {
    const current = await this.get(id);
    if (!current.ok) return current;
    const now = timestamp(this.#clock());
    const written = await this.#write({
      operation: 'tombstone',
      value: {
        ...stripTransport(current.value),
        version: expectedVersion + 1,
        deletedAt: now,
        updatedAt: now,
        updatedBy: this.options.userId,
      } as T,
      expectedVersion,
      audit: {
        campaignId: current.value.campaignId,
        action: `${this.options.featureId}.deleted`,
        targetType: this.options.tableName,
        targetId: id,
        before: { version: expectedVersion },
        at: now,
        private: false,
      },
    });
    return written.ok ? ok(undefined) : written;
  }

  /** Conflicts of this table in the campaign that await a choice. */
  async pendingConflicts(): Promise<MutationConflict[]> {
    return (await this.store.conflicts(this.options.campaignId)).filter(
      (conflict) => conflict.table === this.options.tableName,
    );
  }

  /**
   * Keep the authority, or resubmit the submitted value against the authority's version
   * (`codec.resubmitValue` decides authority-owned fields). Manual merge is not offered (P0).
   */
  async resolveConflict(
    conflictId: string,
    choice: 'keep_authority' | 'resubmit',
  ): Promise<Result<void, RepositoryError>> {
    const conflict = await this.store.conflict(conflictId);
    if (
      conflict === undefined ||
      conflict.table !== this.options.tableName ||
      conflict.resolutionState === 'resolved'
    ) {
      return err({ kind: 'not_found', id: conflictId });
    }
    const resolvedAt = timestamp(this.#clock());
    let resubmit: BrowserLocalWrite | undefined;
    if (choice === 'resubmit') {
      const submitted =
        this.options.codec.resubmitValue?.(conflict.submittedValue, conflict.currentValue) ??
        conflict.submittedValue;
      const next = {
        ...(typeof submitted === 'object' && submitted !== null ? submitted : {}),
        id: conflict.id,
        campaignId: conflict.campaignId,
        version: conflict.actualVersion + 1,
        updatedAt: resolvedAt,
        updatedBy: this.options.userId,
      } as T;
      let row: Readonly<Record<string, string | number | null>> | undefined;
      try {
        row = this.options.codec.toRow(next);
        if (this.options.codec.fromRow({ ...row, id: next.id }) === undefined) row = undefined;
      } catch {
        row = undefined;
      }
      if (row === undefined) {
        return err({ code: 'validation_failed', message: 'Conflict value is invalid.' });
      }
      resubmit = {
        mutationId: this.#createId(),
        campaignId: conflict.campaignId,
        featureId: conflict.featureId,
        tableName: conflict.table,
        recordId: conflict.id,
        operation: 'update',
        expectedVersion: conflict.actualVersion,
        payload: next,
        row,
        audit: {
          campaignId: conflict.campaignId,
          action: 'sync.conflict_resolved',
          targetType: conflict.table,
          targetId: conflict.id,
          after: { conflictId, choice },
          at: resolvedAt,
          private: false,
        },
        recordedAt: resolvedAt,
      };
    }
    const resolved = await this.store.resolveConflict({
      conflictId,
      resolverUserId: this.options.userId,
      resolvedAt,
      ...(resubmit === undefined ? {} : { resubmit }),
    });
    this.options.written?.();
    return resolved ? ok(undefined) : err({ kind: 'not_found', id: conflictId });
  }

  async deferConflict(conflictId: string): Promise<void> {
    await this.store.deferConflict(conflictId);
    this.options.written?.();
  }

  async #write(input: {
    readonly operation: BrowserLocalWrite['operation'];
    readonly value: T;
    readonly expectedVersion: Version | null;
    readonly audit: MutationAuditPayload;
  }): Promise<Result<void, RepositoryError>> {
    if (!isValidMutationAudit(input.audit)) {
      return err({ code: 'validation_failed', message: 'Invalid audit envelope.' });
    }
    const audited = this.options.audited !== false;
    const result = await this.store.record({
      mutationId: this.#createId(),
      campaignId: input.value.campaignId,
      featureId: this.options.featureId,
      tableName: this.options.tableName,
      recordId: input.value.id,
      operation: input.operation,
      expectedVersion: input.expectedVersion,
      checkLocalVersion: true,
      payload: input.value,
      row: this.options.codec.toRow(input.value),
      ...(audited ? { audit: input.audit } : {}),
      recordedAt: input.audit.at,
    });
    if (!result.ok) {
      return result.reason === 'not_found'
        ? err({ kind: 'not_found', id: input.value.id })
        : err({
            kind: 'version_conflict',
            id: input.value.id,
            expectedVersion: input.expectedVersion ?? 0,
            actualVersion: result.actualVersion,
          });
    }
    this.options.written?.();
    return ok(undefined);
  }

  #clock(): Date {
    return this.options.clock?.() ?? new Date();
  }

  #createId(): string {
    return this.options.createId?.() ?? crypto.randomUUID();
  }
}

/**
 * The stored record never keeps the transport-only `holdVersion` (feature 16 long text) or
 * `visibilityChange` (feature 17 reveal intent).
 */
function stripTransport<T extends object>(record: T): T {
  if (!('holdVersion' in record) && !('visibilityChange' in record)) return record;
  const {
    holdVersion: _hold,
    visibilityChange: _change,
    ...rest
  } = record as T & {
    holdVersion?: unknown;
    visibilityChange?: unknown;
  };
  return rest as T;
}

/** PowerSync tables are views: no UPSERT, so read then insert or fill. */
async function ensureReplicaId(tx: BrowserSqlTransaction, campaignId: string): Promise<string> {
  const state = await tx.getOptional<{ replica_id: string | null }>(
    'SELECT replica_id FROM sync_campaign_state WHERE id = ?',
    [campaignId],
  );
  if (state?.replica_id) return state.replica_id;
  const replicaId = crypto.randomUUID();
  if (state === null) {
    await tx.execute(
      `INSERT INTO sync_campaign_state (id, campaign_id, replica_state, replica_id)
       VALUES (?, ?, 'populating', ?)`,
      [campaignId, campaignId, replicaId],
    );
  } else {
    await tx.execute('UPDATE sync_campaign_state SET replica_id = ? WHERE id = ?', [
      replicaId,
      campaignId,
    ]);
  }
  return replicaId;
}

function toMembership(row: MembershipRow): CachedMembership {
  return {
    campaignId: row.campaign_id,
    userId: row.user_id,
    role: row.role,
    version: Number(row.version),
    updatedAt: row.updated_at,
    removedAt: row.removed_at ?? null,
  };
}

function parsePayload(payload: string | null): {
  readonly value?: unknown;
  readonly audit?: MutationAuditPayload;
} {
  if (payload === null) return {};
  return JSON.parse(payload) as { value?: unknown; audit?: MutationAuditPayload };
}

function toPendingMutation(row: MutationRow): PendingMutation {
  const payload = parsePayload(row.payload);
  return {
    mutationId: row.id,
    campaignId: row.campaign_id,
    featureId: row.feature_id,
    tableName: row.table_name,
    recordId: row.record_id,
    operation: row.operation,
    expectedVersion: row.expected_version,
    payload: payload.value ?? null,
    ...(payload.audit === undefined ? {} : { audit: payload.audit }),
    causalSequence: row.causal_sequence,
    state: 'uploading',
    attemptCount: row.attempt_count + 1,
    recordedAt: row.recorded_at,
  };
}

function timestamp(value: Date): string {
  return value.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export interface BrowserMutationSource {
  nextBatch(): Promise<MutationBatch | undefined>;
  applyOutcomes(outcomes: readonly MutationOutcome[], at: string): Promise<void>;
}

/**
 * Where provider credentials come from. The sync streams are per user (`auth.user_id()`), while
 * `GET /sync/bootstrap/:campaignId` authorizes one campaign, so any campaign the user still
 * belongs to yields a token for the user's whole replica.
 */
export interface BrowserCredentialSource {
  /** Candidate campaigns, in order. */
  campaigns(): Promise<readonly string[]>;
  replicaId(campaignId: string): Promise<string>;
  /** Bootstrap answered "not found or forbidden" for this campaign. */
  accessDenied(campaignId: string): Promise<unknown>;
  /** Every candidate was denied: no credential exists for this user any more. */
  noAccess(): void;
}

export class RegisteredPowerSyncConnector implements PowerSyncBackendConnector {
  constructor(
    private readonly credentials: BrowserCredentialSource,
    private readonly mutations: BrowserMutationSource,
    private readonly request: SyncFetch = (input, init) => fetch(input, init),
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async fetchCredentials() {
    const campaigns = await this.credentials.campaigns();
    let denied = 0;
    for (const campaignId of campaigns) {
      const replicaId = await this.credentials.replicaId(campaignId);
      const response = await this.request(
        `/sync/bootstrap/${campaignId}?replicaId=${encodeURIComponent(replicaId)}`,
        { credentials: 'include' },
      );
      if (response.status === 404) {
        denied += 1;
        await this.credentials.accessDenied(campaignId);
        continue;
      }
      if (!response.ok) throw new Error('sync_bootstrap_failed');
      const body = (await response.json()) as { readonly endpoint: string; readonly token: string };
      return { endpoint: body.endpoint, token: body.token };
    }
    if (denied > 0 && denied === campaigns.length) this.credentials.noAccess();
    throw new Error(campaigns.length === 0 ? 'sync_no_campaign' : 'sync_bootstrap_failed');
  }

  /**
   * The provider calls this while local optimistic writes are queued (`ps_crud`). The upload is
   * the registered mutation batch from `sync_pending_mutations`, never the raw row diff. The
   * provider's queue is completed only when no confirmed mutation is left to upload; a transport
   * failure or a retryable outcome throws, so the provider retries with the same mutation ids.
   */
  async uploadData(database: AbstractPowerSyncDatabase): Promise<void> {
    const trigger = await database.getCrudBatch(1000);
    for (;;) {
      const batch = await this.mutations.nextBatch();
      if (batch === undefined) break;
      const response = await this.request('/sync/mutations', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(batch),
      });
      if (!response.ok) throw new Error('sync_upload_failed');
      const body = (await response.json()) as { readonly outcomes: readonly MutationOutcome[] };
      await this.mutations.applyOutcomes(body.outcomes, timestamp(this.clock()));
      if (body.outcomes.some((outcome) => outcome.status === 'error' && outcome.retryable)) {
        throw new Error('sync_upload_retry');
      }
    }
    await trigger?.complete();
  }
}

export interface BrowserSyncSessionOptions {
  readonly userId: string;
  /** Feature 01's `reconcileMembershipCache`, injected by the composition root. */
  readonly reconcile: MembershipReconcile;
  /** One replica per signed-in user (the streams are per user). */
  readonly filename?: string;
  readonly forceBackend?: BrowserStorageBackend;
  readonly assetBaseUrl?: string;
  readonly request?: SyncFetch;
  readonly listeners?: readonly ReplicaPurgeListener[];
  readonly connection?: Pick<PowerSyncConnectionOptions, 'retryDelayMs' | 'crudUploadThrottleMs'>;
  /** Browser network state; defaults to `navigator.onLine`. */
  readonly online?: () => boolean;
  /** Feature-owned replicated tables, added to every replica schema (feature 16 task 04). */
  readonly tables?: FeatureReplicaTables;
}

export const NO_CAMPAIGN_ACCESS_CODE = 'no_campaign_access';

/**
 * Browser composition of the read path (feature 03 tasks 04/07/08): the PowerSync web client
 * writes authorized rows into browser SQLite; membership rows drive `ReplicaAccessReconciler`;
 * provider status, the local queue, and unresolved conflicts drive one `SyncStatusStore`.
 */
export class BrowserSyncSession {
  readonly status = new SyncStatusStore();
  readonly database: PowerSyncDatabase;
  readonly backend: BrowserStorageBackend;
  readonly store: BrowserReplicaStore;
  readonly replicas: BrowserReplicaManager;
  readonly access: ReplicaAccessReconciler;
  /** Feature 06 task 04: local audit stores (merged reads, window state). */
  readonly audit: AuditReplicaStore;
  readonly auditWindows: AuditWindowManager;
  readonly #options: BrowserSyncSessionOptions;
  readonly #hints = new Set<string>();
  readonly #disposers: (() => void)[] = [];
  #lastSyncedAt: string | undefined;
  #work: Promise<unknown> = Promise.resolve();
  #noAccess = false;
  /** The replica schema holds `audit_private_events` (a current GM role somewhere). */
  #privateAudit = false;
  #connectRequested = false;
  /** Last audit acknowledgement accepted per `campaign|table` (this session only). */
  readonly #auditAcknowledged = new Map<string, string>();
  #auditSyncedStreams = '';
  /** Set by `signOut`: a membership pass queued behind it must not refill the cleared cache. */
  #signingOut = false;

  private constructor(options: BrowserSyncSessionOptions) {
    this.#options = options;
    const { database, backend } = createBrowserReplicaDatabase({
      filename: options.filename ?? `rpg-replica-${options.userId}.sqlite`,
      schema: replicaSchema({ privateAudit: false, tables: options.tables ?? {} }),
      ...(options.forceBackend === undefined ? {} : { forceBackend: options.forceBackend }),
      ...(options.assetBaseUrl === undefined ? {} : { assetBaseUrl: options.assetBaseUrl }),
    });
    this.database = database;
    this.backend = backend;
    this.store = new BrowserReplicaStore(database, {
      featureTables: Object.keys(options.tables ?? {}),
    });
    this.replicas = new BrowserReplicaManager(this.store, this.status, options.listeners ?? []);
    this.access = new ReplicaAccessReconciler(this.store, this.replicas, options.reconcile);
    this.audit = new AuditReplicaStore(
      database,
      () => this.#privateAudit,
      (campaignId) => this.store.campaignCreatedAt(campaignId),
    );
    this.auditWindows = new AuditWindowManager(this.audit, {
      subscribe: (stream, parameters) =>
        database.syncStream(stream, parameters).subscribe({ ttl: AUDIT_SUBSCRIPTION_TTL_SECONDS }),
      forget: (stream, parameters) => database.syncStream(stream, parameters).unsubscribeAll(),
      synced: (stream, parameters) =>
        database.currentStatus.forStream({ name: stream, parameters: { ...parameters } })
          ?.subscription.hasSynced === true,
    });
    // A purged campaign leaves its audit windows before its local state is dropped.
    this.replicas.beforePurge = async (campaignId) =>
      this.auditWindows.forgetCampaign(campaignId, await this.audit.window(campaignId));
  }

  /** Opens the local replica (usable offline) before any network activity. */
  static async open(options: BrowserSyncSessionOptions): Promise<BrowserSyncSession> {
    const session = new BrowserSyncSession(options);
    await session.database.init();
    // Not connected yet: the schema follows the cached roles before any provider activity.
    await session.#syncAuditSchema().catch(() => false);
    await session.refreshCounts();
    session.#applyProviderStatus(session.database.currentStatus);
    session.#disposers.push(
      session.database.registerListener({
        statusChanged: (status) => session.#applyProviderStatus(status),
      }),
      session.database.onChange(
        { onChange: () => void session.refreshCounts() },
        { tables: ['sync_pending_mutations', 'sync_conflicts'], throttleMs: 20 },
      ),
      session.database.onChange(
        { onChange: () => void session.reconcileMemberships() },
        { tables: ['identity_campaign_memberships'], throttleMs: 20 },
      ),
    );
    if (typeof globalThis.addEventListener === 'function') {
      const network = () => session.#applyProviderStatus(session.database.currentStatus);
      globalThis.addEventListener('online', network);
      globalThis.addEventListener('offline', network);
      session.#disposers.push(() => {
        globalThis.removeEventListener('online', network);
        globalThis.removeEventListener('offline', network);
      });
    }
    return session;
  }

  /** Starts provider synchronization; `campaignId` names a campaign just joined or opened. */
  async connect(campaignId?: string): Promise<void> {
    if (campaignId !== undefined) this.#hints.add(campaignId);
    this.#noAccess = false;
    this.#signingOut = false;
    this.#connectRequested = true;
    await this.#refreshAudit(false);
    await this.#connectProvider();
  }

  async #connectProvider(): Promise<void> {
    const connector = new RegisteredPowerSyncConnector(
      {
        campaigns: () => this.#candidateCampaigns(),
        replicaId: (id) => this.store.replicaId(id),
        // Not awaited: `#refreshAudit` runs provider disconnects and reconnects inside the
        // serialized work and those wait for this credential fetch, so waiting here for a purge
        // queued behind them would deadlock the session and never purge the replica.
        accessDenied: async (id) => {
          void this.#serialize(() => this.access.accessDenied(id)).catch(() => undefined);
        },
        noAccess: () => {
          // Not awaited: the provider is still inside `fetchCredentials`.
          setTimeout(() => void this.#clearProviderData(), 0);
        },
      },
      this.store,
      this.#options.request,
    );
    await this.database.connect(connector, {
      connectionMethod: SyncStreamConnectionMethod.HTTP,
      ...this.#options.connection,
    });
  }

  async disconnect(): Promise<void> {
    this.#connectRequested = false;
    await this.database.disconnect();
  }

  /**
   * Re-plans every current campaign's audit window (compaction) and applies it as stream
   * subscriptions; switches the schema when the user gains or loses every GM role. Audit is
   * derived: a failure here never blocks synchronization.
   */
  refreshAudit(): Promise<void> {
    return this.#serialize(() => this.#refreshAudit(true));
  }

  async #refreshAudit(reconnect: boolean): Promise<void> {
    try {
      const changed = await this.#syncAuditSchema();
      for (const row of await this.store.cachedMemberships()) {
        if (row.removedAt === null) {
          await this.auditWindows.refresh(row.campaignId, {
            privateStore: GM_ROLES.includes(row.role),
          });
        }
      }
      if (changed && reconnect && this.#connectRequested && !this.#noAccess) {
        await this.#connectProvider();
      }
    } catch {
      // Derived data: synchronization of the domain replica continues without it.
    }
  }

  /** Schema changes need a disconnected client; returns whether it changed. */
  async #syncAuditSchema(): Promise<boolean> {
    const cached = await this.store.cachedMemberships();
    const gm = cached.some((row) => row.removedAt === null && GM_ROLES.includes(row.role));
    if (gm === this.#privateAudit) return false;
    if (this.#connectRequested) await this.database.disconnect();
    await this.database.updateSchema(
      replicaSchema({ privateAudit: gm, tables: this.#options.tables ?? {} }),
    );
    this.#privateAudit = gm;
    return true;
  }

  /** Local-first write: readable immediately, queued durably, uploaded when connected. */
  async record(write: BrowserLocalWrite): Promise<BrowserRecordResult> {
    const result = await this.store.record(write);
    await this.refreshCounts();
    return result;
  }

  /**
   * A `SyncedRepository` over one feature-owned replica table passed in `tables` (feature 16
   * task 11). Local writes refresh the pending count.
   */
  repository<T extends EntityEnvelope>(options: {
    readonly tableName: string;
    readonly featureId: string;
    readonly campaignId: string;
    readonly codec: BrowserRecordCodec<T>;
    readonly audited?: boolean;
  }): BrowserSyncedRepository<T> {
    return new BrowserSyncedRepository<T>(this.store, {
      ...options,
      userId: this.#options.userId,
      written: () => void this.refreshCounts(),
    });
  }

  async refreshCounts(): Promise<void> {
    this.status.setPendingCount(await this.store.pendingCount());
    this.status.setUnresolvedConflicts(await this.store.unresolvedCount());
  }

  /**
   * Applies the replicated membership rows as the complete current-user set. Runs only once the
   * provider has applied a consistent checkpoint (`hasSynced`); PowerSync exposes checkpoints
   * atomically, so absence is real.
   */
  reconcileMemberships(): Promise<unknown> {
    return this.#serialize(async () => {
      if (this.#noAccess || this.#signingOut || this.database.currentStatus.hasSynced !== true) {
        return;
      }
      const rows = await this.store.replicatedMemberships();
      await this.access.applyMemberships(this.#options.userId, rows, { complete: true });
      await this.#refreshAudit(true);
      await this.#acknowledgeAudit();
    });
  }

  /**
   * Feature 06 retention follow-up: after a consistent checkpoint, tells the authority which
   * audit events this replica durably holds (`POST /sync/replicas/:campaignId/ack`), so an
   * active replica stops holding back server retention. Only a changed claim is sent; a failure
   * is retried on the next checkpoint and never affects synchronization.
   */
  async #acknowledgeAudit(): Promise<void> {
    if (this.#signingOut) return;
    const request = this.#options.request ?? ((input, init) => fetch(input, init));
    for (const row of await this.store.cachedMemberships()) {
      if (row.removedAt !== null) continue;
      try {
        const acknowledgements = await this.auditWindows.acknowledgements(row.campaignId);
        if (acknowledgements.length === 0) continue;
        const replicaId = await this.store.replicaId(row.campaignId);
        for (const acknowledgement of acknowledgements) {
          const sent = `${acknowledgement.campaignId}|${acknowledgement.tableName}`;
          if (this.#auditAcknowledged.get(sent) === acknowledgement.throughEventId) continue;
          const response = await request(`/sync/replicas/${acknowledgement.campaignId}/ack`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              replicaId,
              tableName: acknowledgement.tableName,
              throughEventId: acknowledgement.throughEventId,
            }),
          });
          if (response.ok) this.#auditAcknowledged.set(sent, acknowledgement.throughEventId);
        }
      } catch {
        // Derived data: the watermark stays where it was until the next checkpoint.
      }
    }
  }

  /** Sign-out: every campaign replica, the queue, and the membership cache leave the device. */
  async signOut(): Promise<void> {
    this.#signingOut = true;
    await this.#serialize(() => this.replicas.signOut());
    this.#connectRequested = false;
    await this.database.disconnectAndClear({ clearLocal: true });
    this.status.setConnected(false);
  }

  async close(): Promise<void> {
    for (const dispose of this.#disposers.splice(0)) dispose();
    await this.#work.catch(() => undefined);
    await this.database.close();
  }

  async #candidateCampaigns(): Promise<string[]> {
    const cached = await this.store.cachedMemberships();
    const revoked = new Set(
      cached.filter((row) => row.removedAt !== null).map((row) => row.campaignId),
    );
    const candidates = [
      ...cached.filter((row) => row.removedAt === null).map((row) => row.campaignId),
      ...this.#hints,
    ];
    return [...new Set(candidates)].filter((id) => !revoked.has(id) || this.#hints.has(id));
  }

  /** No campaign authorizes this user: provider rows cannot be revoked remotely, clear them. */
  async #clearProviderData(): Promise<void> {
    this.#noAccess = true;
    await this.database.disconnectAndClear({ clearLocal: false });
    this.status.fail(NO_CAMPAIGN_ACCESS_CODE);
  }

  #applyProviderStatus(provider: ProviderSyncStatus): void {
    if (this.#noAccess) return;
    const online = this.#options.online?.() ?? globalThis.navigator?.onLine ?? true;
    if (provider.hasSynced === true) {
      const lastSyncedAt = provider.lastSyncedAt;
      if (lastSyncedAt !== undefined && lastSyncedAt.toISOString() !== this.#lastSyncedAt) {
        this.#lastSyncedAt = lastSyncedAt.toISOString();
        this.status.synchronized(timestamp(lastSyncedAt));
        void this.reconcileMemberships();
      }
      this.#auditStreamsSynced(provider);
      this.status.setInitialSyncProgress(undefined);
    } else {
      this.status.setInitialSyncProgress(provider.downloadProgress?.downloadedFraction ?? 0);
    }
    this.status.setConnected(online && provider.connected);
    if (!online) return;
    const flow = provider.dataFlowStatus;
    if (flow.uploadError !== undefined) this.status.fail('upload_failed');
    else if (!provider.connected && flow.downloadError !== undefined) {
      this.status.fail('transport_failed');
    } else this.status.clearError();
  }

  /**
   * An audit window can finish its first download after the checkpoint that ran the membership
   * pass, so a change in the set of synced audit subscriptions also triggers acknowledgement.
   */
  #auditStreamsSynced(provider: ProviderSyncStatus): void {
    const synced = (provider.syncStreams ?? [])
      .map((stream) => stream.subscription)
      .filter(
        (subscription) =>
          subscription.hasSynced &&
          (subscription.name === AUDIT_CAMPAIGN_STREAM ||
            subscription.name === AUDIT_PRIVATE_STREAM),
      )
      .map((subscription) => `${subscription.name}|${JSON.stringify(subscription.parameters)}`)
      .sort()
      .join(',');
    if (synced === this.#auditSyncedStreams) return;
    this.#auditSyncedStreams = synced;
    void this.#serialize(() => this.#acknowledgeAudit());
  }

  #serialize<T>(task: () => Promise<T>): Promise<T> {
    const next = this.#work.then(task, task);
    this.#work = next.catch(() => undefined);
    return next;
  }
}
