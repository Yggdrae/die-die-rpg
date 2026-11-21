import type { SyncStatus } from '@rpg/sync';
import {
  BrowserReplicaStore,
  type BrowserStorageBackend,
  BrowserSyncSession,
  createBrowserReplicaDatabase,
} from '@rpg/sync/browser';
import { createElement, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { reconcileMembershipCache } from './membership-rule.ts';
import { SyncStatusIndicator, syncStatusLabel } from './SyncStatus.tsx';

/** Playwright-only (imported dynamically from specs; never from production code). */

export async function persistCampaignState(input: {
  readonly backend: BrowserStorageBackend;
  readonly filename: string;
  readonly campaignId: string;
}): Promise<void> {
  const { database } = createBrowserReplicaDatabase({
    filename: input.filename,
    forceBackend: input.backend,
  });
  await database.init();
  await database.execute(
    `INSERT OR REPLACE INTO sync_campaign_state (id, campaign_id, replica_state)
     VALUES (?, ?, 'available')`,
    [input.campaignId, input.campaignId],
  );
  await database.close();
}

export async function reopenCampaignState(input: {
  readonly backend: BrowserStorageBackend;
  readonly filename: string;
  readonly campaignId: string;
}): Promise<{ readonly state?: string; readonly openMs: number }> {
  const startedAt = performance.now();
  const { database } = createBrowserReplicaDatabase({
    filename: input.filename,
    forceBackend: input.backend,
  });
  await database.init();
  const row = await database.getOptional<{ replica_state: string }>(
    'SELECT replica_state FROM sync_campaign_state WHERE id = ?',
    [input.campaignId],
  );
  const openMs = performance.now() - startedAt;
  await database.close();
  return { ...(row === null ? {} : { state: row.replica_state }), openMs };
}

let live: BrowserSyncSession | undefined;
/** Every status the session published, with whether a consistent checkpoint existed then. */
let history: {
  readonly state: SyncStatus['state'];
  readonly label: string;
  readonly hasSynced: boolean;
}[] = [];

function session(): BrowserSyncSession {
  if (live === undefined) throw new Error('no live session');
  return live;
}

/** Opens the user's replica through the production session and renders its status. */
export async function openLiveSession(input: {
  readonly userId: string;
  readonly filename: string;
  readonly backend: BrowserStorageBackend;
  readonly campaignId?: string;
  readonly connect: boolean;
  /** Feature 05: also open the user's offline attachment store as a purge listener. */
  readonly attachments?: boolean;
}): Promise<{ readonly backend: BrowserStorageBackend }> {
  await live?.close();
  const listeners = input.attachments === true ? [await openAttachmentStore(input.userId)] : [];
  live = await BrowserSyncSession.open({
    userId: input.userId,
    filename: input.filename,
    forceBackend: input.backend,
    reconcile: reconcileMembershipCache,
    connection: { retryDelayMs: 300, crudUploadThrottleMs: 50 },
    listeners,
  });
  const opened = live;
  history = [];
  opened.status.subscribe((status) =>
    history.push({
      state: status.state,
      label: syncStatusLabel(status),
      hasSynced: opened.database.currentStatus.hasSynced === true,
    }),
  );
  mountStatus(opened);
  if (input.connect) await live.connect(input.campaignId);
  return { backend: live.backend };
}

export async function connectLive(campaignId?: string): Promise<void> {
  await session().connect(campaignId);
}

export async function closeLiveSession(): Promise<void> {
  await live?.close();
  live = undefined;
}

export async function signOutLive(): Promise<void> {
  await session().signOut();
}

export function liveStatus(): SyncStatus & { readonly label: string; readonly rendered: string } {
  const status = session().status.snapshot();
  return {
    ...status,
    label: syncStatusLabel(status),
    rendered: document.querySelector('[data-sync-state]')?.textContent ?? '',
  };
}

/** Everything a test asserts against: the browser SQLite contents, not the interface. */
export async function liveRows() {
  const database = session().database;
  const store = session().store;
  return {
    hasSynced: database.currentStatus.hasSynced === true,
    campaigns: await store.campaigns(),
    settings: await store.settings(),
    memberships: await store.replicatedMemberships(),
    cache: await store.cachedMemberships(),
    pending: await database.getAll<{ id: string; state: string; attempt_count: number }>(
      'SELECT id, state, attempt_count FROM sync_pending_mutations ORDER BY causal_sequence',
    ),
    conflicts: await database.getAll<{ mutation_id: string; submitted_value: string }>(
      'SELECT mutation_id, submitted_value FROM sync_conflicts',
    ),
    pendingCount: await store.pendingCount(),
  };
}

/** Offline-capable edit of the campaign details through the registered campaign applier shape. */
export async function renameCampaignLocally(input: {
  readonly campaignId: string;
  readonly name: string;
  readonly expectedVersion: number;
  readonly mutationId?: string;
}): Promise<string> {
  const mutationId = input.mutationId ?? crypto.randomUUID();
  await session().record({
    mutationId,
    campaignId: input.campaignId,
    featureId: 'campaigns',
    tableName: 'campaigns',
    recordId: input.campaignId,
    operation: 'update',
    expectedVersion: input.expectedVersion,
    payload: { name: input.name, description: '' },
    row: { name: input.name },
    recordedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  });
  return mutationId;
}

/**
 * Cold open of a warm replica: from creating the database to the first campaign read (the
 * local part of "usable"), closed in between so every sample reopens the worker and storage.
 */
export async function measureWarmOpen(input: {
  readonly filename: string;
  readonly backend: BrowserStorageBackend;
  readonly samples: number;
}): Promise<{ readonly samples: number[]; readonly campaigns: number }> {
  await live?.close();
  live = undefined;
  const samples: number[] = [];
  let campaigns = 0;
  for (let sample = 0; sample < input.samples; sample += 1) {
    const startedAt = performance.now();
    const { database } = createBrowserReplicaDatabase({
      filename: input.filename,
      forceBackend: input.backend,
    });
    await database.init();
    const store = new BrowserReplicaStore(database);
    const rows = await store.campaigns();
    await store.settings();
    samples.push(performance.now() - startedAt);
    campaigns = rows.length;
    await database.close();
  }
  return { samples, campaigns };
}

function mountStatus(current: BrowserSyncSession): void {
  const host = document.createElement('div');
  host.id = 'sync-status-host';
  document.getElementById('sync-status-host')?.remove();
  document.body.append(host);
  function Status() {
    const [status, setStatus] = useState(() => current.status.snapshot());
    useEffect(() => current.status.subscribe(setStatus), []);
    return createElement(SyncStatusIndicator, { status });
  }
  createRoot(host).render(createElement(Status));
}

export function liveStatusHistory() {
  return history;
}

/** The real dashboard composition (`useBrowserSync`), unmounted on logout. */
export async function mountDashboard(input: {
  readonly userId: string;
  readonly campaignId: string;
}): Promise<void> {
  const { CampaignDashboard } = await import('../campaigns/CampaignDashboard.tsx');
  const host = document.createElement('div');
  host.id = 'dashboard-host';
  document.body.append(host);
  const root = createRoot(host);
  root.render(
    createElement(CampaignDashboard, {
      userId: input.userId,
      initialCampaignId: input.campaignId,
      onLogout: () => {
        root.unmount();
        document.body.dataset.loggedOut = 'true';
      },
    }),
  );
}

/**
 * Feature 06 task 04: the replica's audit stores as browser SQLite holds them, plus every trace of
 * the private store (schema objects, PowerSync's untyped rows and stream subscriptions).
 */
export async function liveAudit() {
  const current = session();
  const db = current.database;
  const objects = await db.getAll<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE name LIKE '%audit_private%' ORDER BY name",
  );
  const ids = async (table: string) =>
    (await db.getAll<{ id: string }>(`SELECT id FROM ${table} ORDER BY id`)).map((row) => row.id);
  const internal = await db.getAll<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('ps_untyped', 'ps_stream_subscriptions')",
  );
  let internalText = '';
  for (const { name } of internal) {
    internalText += JSON.stringify(await db.getAll(`SELECT * FROM ${name}`));
  }
  return {
    campaign: await ids('audit_campaign_events'),
    private: objects.some((row) => row.name === 'audit_private_events')
      ? await ids('audit_private_events')
      : null,
    privateObjects: objects.map((row) => row.name),
    subscriptions: current.auditWindows.active(),
    internalMentionsPrivate:
      internalText.includes('audit_private') || internalText.includes('gm_private_audit'),
  };
}

/**
 * Feature 05 task 05: the production offline attachment store (IndexedDB) as the session's
 * `ReplicaPurgeListener`. Its network source is never reached here; the spec seeds a pinned
 * attachment directly and observes what the feature 03 removal signal leaves behind.
 */
let attachmentStore: import('@rpg/attachments/offline').OfflineAttachmentStore | undefined;
let attachmentDb: import('../attachments/offline-db.ts').IndexedDbOfflineAttachmentDb | undefined;

async function openAttachmentStore(userId: string) {
  const { OfflineAttachmentStore } = await import('@rpg/attachments/offline');
  const { IndexedDbOfflineAttachmentDb, offlineAttachmentDbName } = await import(
    '../attachments/offline-db.ts'
  );
  attachmentDb?.close();
  attachmentDb = await IndexedDbOfflineAttachmentDb.open(offlineAttachmentDbName(userId));
  attachmentStore = new OfflineAttachmentStore({
    db: attachmentDb,
    source: {
      offlineSet: async () => ({ kind: 'offline' }),
      download: async () => ({ kind: 'failed' }),
      check: async () => 'offline',
    },
  });
  return attachmentStore;
}

/** Writes one pinned attachment (record and bytes) for `campaignId` into the user's store. */
export async function seedPinnedAttachment(input: {
  readonly userId: string;
  readonly campaignId: string;
  readonly attachmentId: string;
}): Promise<void> {
  const { IndexedDbOfflineAttachmentDb, offlineAttachmentDbName } = await import(
    '../attachments/offline-db.ts'
  );
  const db = await IndexedDbOfflineAttachmentDb.open(offlineAttachmentDbName(input.userId));
  const bytes = new Uint8Array(64).fill(7);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  await db.put(
    {
      attachmentId: input.attachmentId,
      campaignId: input.campaignId,
      owner: { resourceClass: 'fixture_note', resourceId: input.attachmentId },
      filename: 'pinned-map.png',
      mime: 'image/png',
      size: bytes.byteLength,
      checksum: [...digest].map((value) => value.toString(16).padStart(2, '0')).join(''),
      version: 1,
      state: 'pinned',
      downloadedBytes: bytes.byteLength,
      pinRequestedAt: new Date().toISOString(),
    },
    bytes,
  );
  db.close();
}

/** Attachment IDs with a record, and with bytes, in the user's store. */
export async function offlineAttachmentIds(userId: string) {
  const { IndexedDbOfflineAttachmentDb, offlineAttachmentDbName } = await import(
    '../attachments/offline-db.ts'
  );
  const db = await IndexedDbOfflineAttachmentDb.open(offlineAttachmentDbName(userId));
  const records = await db.all();
  const withBytes: string[] = [];
  for (const record of records) {
    if ((await db.bytes(record.attachmentId)) !== undefined) withBytes.push(record.attachmentId);
  }
  db.close();
  return { records: records.map((record) => record.attachmentId).sort(), bytes: withBytes.sort() };
}
