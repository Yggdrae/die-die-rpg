import {
  type AbstractPowerSyncDatabase,
  column,
  type PowerSyncBackendConnector,
  PowerSyncDatabase,
  Schema,
  Table,
  WASQLiteOpenFactory,
  WASQLiteVFS,
} from '@powersync/web';
import type { MutationBatch, MutationOutcome } from './model.ts';

export type BrowserStorageBackend = 'opfs' | 'indexeddb';
export type SyncFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export const SyncBookkeepingSchema = new Schema({
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
  sync_campaign_state: new Table(
    {
      campaign_id: column.text,
      replica_state: column.text,
      last_server_cursor: column.text,
      last_sync_at: column.text,
      last_error_code: column.text,
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
});

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

export interface BrowserMutationSource {
  nextBatch(): Promise<MutationBatch | undefined>;
  applyOutcomes(outcomes: readonly MutationOutcome[]): Promise<void>;
}

export class RegisteredPowerSyncConnector implements PowerSyncBackendConnector {
  constructor(
    private readonly campaignId: string,
    private readonly mutations: BrowserMutationSource,
    private readonly request: SyncFetch = fetch,
    private readonly onAccessRevoked: () => Promise<void> | void = () => undefined,
  ) {}

  async fetchCredentials() {
    const response = await this.request(`/sync/bootstrap/${this.campaignId}`, {
      credentials: 'include',
    });
    if (response.status === 404) await this.onAccessRevoked();
    if (!response.ok) throw new Error('sync_bootstrap_failed');
    const body = (await response.json()) as { readonly endpoint: string; readonly token: string };
    return { endpoint: body.endpoint, token: body.token };
  }

  async uploadData(database: AbstractPowerSyncDatabase): Promise<void> {
    const trigger = await database.getCrudBatch();
    if (trigger === null) return;
    const batch = await this.mutations.nextBatch();
    if (batch === undefined) {
      await trigger.complete();
      return;
    }
    const response = await this.request('/sync/mutations', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(batch),
    });
    if (!response.ok) throw new Error('sync_upload_failed');
    const body = (await response.json()) as { readonly outcomes: readonly MutationOutcome[] };
    await this.mutations.applyOutcomes(body.outcomes);
    if (body.outcomes.every((outcome) => outcome.status !== 'error' || !outcome.retryable)) {
      await trigger.complete();
    }
  }
}
