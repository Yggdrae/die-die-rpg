import {
  type AbstractPowerSyncDatabase,
  column,
  type PowerSyncBackendConnector,
  PowerSyncDatabase,
  Schema,
  Table,
} from '@powersync/web';

/**
 * Task 10, sync question: does a write made offline in local SQLite reach PostgreSQL and
 * come back?
 *
 * Output is a go/no-go on the `SyncedRepository` contract before twenty features are
 * written against it. Throwaway.
 */

export type Report = { label: string; ok: boolean; detail: string };

// Same-origin through the Vite proxy. Chromium cannot reach the WSL VM address directly
// on this machine (see vite.config.ts).
const BACKEND = '/api';

const schema = new Schema({
  entity: new Table({
    campaign_id: column.text,
    name: column.text,
    version: column.integer,
  }),
});

let uploadLog: unknown[] = [];

class SpikeConnector implements PowerSyncBackendConnector {
  async fetchCredentials() {
    const response = await fetch(`${BACKEND}/token`);
    const { token, endpoint } = (await response.json()) as { token: string; endpoint: string };
    return { endpoint, token };
  }

  /**
   * Writes do NOT flow through the sync service. PowerSync hands the queued batch here and
   * the application's own backend is what touches PostgreSQL. This asymmetry is the
   * contract-relevant finding.
   */
  async uploadData(database: AbstractPowerSyncDatabase) {
    const batch = await database.getCrudBatch();
    if (batch === null) {
      return;
    }

    const payload = batch.crud.map((entry) => ({
      op: entry.op,
      type: entry.table,
      id: entry.id,
      data: entry.opData,
    }));

    const response = await fetch(`${BACKEND}/upload`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const result = (await response.json()) as { applied: unknown[] };
    uploadLog = uploadLog.concat(result.applied);

    // Completing the batch is unconditional here on purpose: a rejected write is reported
    // by the backend, not by the queue. See the conflict report below.
    await batch.complete();
  }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return true;
    }
    await wait(250);
  }
  return false;
}

export async function runSyncTest(): Promise<Report[]> {
  const reports: Report[] = [];

  const db = new PowerSyncDatabase({
    schema,
    database: { dbFilename: `spike-sync-${Date.now()}.sqlite3` },
  });

  try {
    await db.init();
    reports.push({ label: 'local PowerSync database opens', ok: true, detail: 'initialised' });
  } catch (error) {
    reports.push({
      label: 'local PowerSync database opens',
      ok: false,
      detail: String(error instanceof Error ? error.message : error),
    });
    return reports;
  }

  // --- 1. PostgreSQL -> local SQLite -------------------------------------
  try {
    await db.connect(new SpikeConnector());
    const arrived = await waitFor(async () => {
      const rows = await db.getAll<{ id: string }>('select id from entity');
      return rows.length > 0;
    }, 30_000);

    const rows = await db.getAll<{ id: string; name: string; version: number }>(
      'select id, name, version from entity order by id',
    );
    reports.push({
      label: 'PostgreSQL row reaches local SQLite',
      ok: arrived,
      detail: arrived
        ? `${rows.length} row(s): ${rows.map((r) => `${r.id}=${r.name}@v${r.version}`).join(', ')}`
        : 'no rows arrived within 30s',
    });
  } catch (error) {
    reports.push({
      label: 'PostgreSQL row reaches local SQLite',
      ok: false,
      detail: String(error instanceof Error ? error.message : error),
    });
  }

  // --- 2. Offline write, then reconnect ----------------------------------
  const offlineId = `npc-offline-${Date.now()}`;
  try {
    await db.disconnect();

    const start = performance.now();
    await db.execute('insert into entity (id, campaign_id, name, version) values (?, ?, ?, ?)', [
      offlineId,
      'spike',
      'Written While Offline',
      1,
    ]);
    const localMs = performance.now() - start;

    const local = await db.getAll<{ id: string }>('select id from entity where id = ?', [
      offlineId,
    ]);
    reports.push({
      label: 'write succeeds locally while disconnected',
      ok: local.length === 1,
      detail: `${local.length} row readable locally, ${localMs.toFixed(1)} ms`,
    });

    const queued = await db.getCrudBatch();
    reports.push({
      label: 'offline write is queued, not lost',
      ok: queued !== null && queued.crud.length > 0,
      detail: `${queued?.crud.length ?? 0} entry in the upload queue`,
    });
  } catch (error) {
    reports.push({
      label: 'offline write',
      ok: false,
      detail: String(error instanceof Error ? error.message : error),
    });
  }

  // --- 3. Reconnect and confirm it reached PostgreSQL --------------------
  try {
    uploadLog = [];
    await db.connect(new SpikeConnector());

    const landed = await waitFor(async () => {
      const response = await fetch(`${BACKEND}/entities`);
      const { rows } = (await response.json()) as { rows: { id: string }[] };
      return rows.some((row) => row.id === offlineId);
    }, 30_000);

    reports.push({
      label: 'queued write reaches PostgreSQL after reconnect',
      ok: landed,
      detail: landed
        ? `applied: ${JSON.stringify(uploadLog).slice(0, 160)}`
        : 'did not appear in PostgreSQL within 30s',
    });
  } catch (error) {
    reports.push({
      label: 'queued write reaches PostgreSQL after reconnect',
      ok: false,
      detail: String(error instanceof Error ? error.message : error),
    });
  }

  // --- 4. Conflict detection is server-side and asynchronous -------------
  try {
    // Someone else advances the row while this client is offline.
    await db.disconnect();
    await fetch(`${BACKEND}/seed?id=npc-1&name=ChangedByAnotherClient`);

    // This client still believes it is at the version it last saw.
    await db.execute('update entity set name = ?, version = ? where id = ?', [
      'StaleLocalEdit',
      1,
      'npc-1',
    ]);

    uploadLog = [];
    await db.connect(new SpikeConnector());

    const sawConflict = await waitFor(
      async () => uploadLog.some((entry) => (entry as { op?: string }).op === 'CONFLICT'),
      30_000,
    );

    reports.push({
      label: 'stale write is rejected server-side, after the local write reported success',
      ok: sawConflict,
      detail: sawConflict
        ? `conflict surfaced on upload: ${JSON.stringify(uploadLog).slice(0, 200)}`
        : `no conflict reported: ${JSON.stringify(uploadLog).slice(0, 200)}`,
    });
  } catch (error) {
    reports.push({
      label: 'conflict detection',
      ok: false,
      detail: String(error instanceof Error ? error.message : error),
    });
  }

  await db.disconnect();
  await db.close();

  return reports;
}
