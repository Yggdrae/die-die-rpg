/**
 * OPFS via the sqlite-wasm worker1 protocol.
 *
 * Findings that led here, each of which produces a false negative if missed:
 *
 * 1. sqlite-wasm refuses to install the OPFS VFS on the main thread: it needs
 *    `Atomics.wait()`. OPFS is worker-only.
 * 2. The library loads a sibling helper, `sqlite3-opfs-async-proxy.js`, at runtime.
 *    Bundled through Vite that resolution fails.
 * 3. A *module* worker could not spawn the nested classic worker the VFS depends on.
 *    sqlite-wasm ships `sqlite3-worker1.js` as a classic worker precisely for this, and
 *    the worker1 message protocol is the supported OPFS path.
 *
 * Feature 03 inherits all three constraints.
 */

export type Report = { label: string; ok: boolean; detail: string };

type Worker1Response = {
  type: string;
  messageId: string;
  result?: unknown;
};

class Worker1Client {
  readonly #worker: Worker;
  readonly #pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (reason: Error) => void }
  >();
  #counter = 0;
  #ready: Promise<void>;

  constructor(url: string) {
    // Classic worker, string URL: not rewritten by the bundler.
    this.#worker = new Worker(url);

    this.#ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('worker1 did not signal ready')), 15_000);
      const onReady = (event: MessageEvent<Worker1Response>) => {
        if (
          event.data?.type === 'sqlite3-api' &&
          (event.data as { result?: string }).result === 'worker1-ready'
        ) {
          clearTimeout(timer);
          this.#worker.removeEventListener('message', onReady);
          resolve();
        }
      };
      this.#worker.addEventListener('message', onReady);
      this.#worker.addEventListener('error', (event) => {
        clearTimeout(timer);
        reject(new Error(event.message || 'worker failed to load'));
      });
    });

    this.#worker.addEventListener('message', (event: MessageEvent<Worker1Response>) => {
      const data = event.data;
      const entry = this.#pending.get(data?.messageId);
      if (entry === undefined) {
        return;
      }
      this.#pending.delete(data.messageId);
      if (data.type === 'error') {
        const result = data.result as { message?: string } | undefined;
        entry.reject(new Error(result?.message ?? 'worker1 error'));
      } else {
        entry.resolve(data.result);
      }
    });
  }

  ready(): Promise<void> {
    return this.#ready;
  }

  send(type: string, args: Record<string, unknown>, dbId?: string): Promise<unknown> {
    this.#counter += 1;
    const messageId = `m${this.#counter}`;
    return new Promise((resolve, reject) => {
      this.#pending.set(messageId, { resolve, reject });
      this.#worker.postMessage({ type, messageId, dbId, args });
      setTimeout(() => {
        if (this.#pending.delete(messageId)) {
          reject(new Error(`${type} timed out`));
        }
      }, 30_000);
    });
  }

  terminate(): void {
    this.#worker.terminate();
  }
}

export async function runOpfsTest(): Promise<Report[]> {
  const reports: Report[] = [];
  const client = new Worker1Client('/sqlite/sqlite3-worker1.js');

  try {
    await client.ready();
    reports.push({ label: 'worker1 classic worker starts', ok: true, detail: 'ready' });
  } catch (error) {
    reports.push({
      label: 'worker1 classic worker starts',
      ok: false,
      detail: String(error instanceof Error ? error.message : error),
    });
    client.terminate();
    return reports;
  }

  const filename = 'file:spike-opfs.sqlite3?vfs=opfs';
  let dbId: string | undefined;

  try {
    const opened = (await client.send('open', { filename })) as {
      dbId: string;
      filename: string;
      vfs?: string;
    };
    dbId = opened.dbId;
    const usingOpfs = (opened.vfs ?? '').includes('opfs') || opened.filename.includes('opfs');
    reports.push({
      label: 'OPFS VFS in use',
      ok: usingOpfs,
      detail: `vfs=${opened.vfs ?? 'unreported'}, filename=${opened.filename}`,
    });
  } catch (error) {
    reports.push({
      label: 'OPFS VFS in use',
      ok: false,
      detail: String(error instanceof Error ? error.message : error),
    });
    client.terminate();
    return reports;
  }

  const exec = (sql: string, extra: Record<string, unknown> = {}) =>
    client.send('exec', { sql, ...extra }, dbId);

  // Write, close, reopen. The property feature 03 depends on: a campaign synchronized
  // before a session is still there with no network (`PRD.md` s.76).
  try {
    await exec('drop table if exists entity; drop table if exists docs;');
    await exec('create table entity(id text primary key, name text, version integer)');
    await exec("insert into entity values ('npc-1','Merchant',1)");
    await exec('create virtual table docs using fts5(id, body)');
    await exec("insert into docs(id, body) values ('npc-1','the missing caravan never arrived')");
    await client.send('close', {}, dbId);

    const reopened = (await client.send('open', { filename })) as { dbId: string };
    dbId = reopened.dbId;

    const rows = (await client.send(
      'exec',
      { sql: 'select name, version from entity', rowMode: 'object', resultRows: [] },
      dbId,
    )) as { resultRows: { name: string }[] };

    const hits = (await client.send(
      'exec',
      { sql: "select id from docs where docs match 'caravan'", rowMode: 'object', resultRows: [] },
      dbId,
    )) as { resultRows: unknown[] };

    reports.push({
      label: 'OPFS survives close and reopen',
      ok: rows.resultRows.length === 1 && rows.resultRows[0]?.name === 'Merchant',
      detail: `${rows.resultRows.length} row(s) recovered`,
    });
    reports.push({
      label: 'FTS5 index survives in OPFS',
      ok: hits.resultRows.length === 1,
      detail: `${hits.resultRows.length} match(es) after reopen`,
    });
  } catch (error) {
    reports.push({
      label: 'OPFS round trip',
      ok: false,
      detail: String(error instanceof Error ? error.message : error),
    });
  }

  // Durable write throughput at a size a real campaign reaches.
  try {
    await exec('drop table if exists bulk');
    await exec('create table bulk(id integer primary key, payload text)');
    const values = Array.from({ length: 5000 }, (_, i) => `('entity payload ${i}')`).join(',');
    const start = performance.now();
    await exec(`insert into bulk(payload) values ${values}`);
    const ms = performance.now() - start;

    const counted = (await client.send(
      'exec',
      { sql: 'select count(*) as n from bulk', rowMode: 'object', resultRows: [] },
      dbId,
    )) as { resultRows: { n: number }[] };
    const n = counted.resultRows[0]?.n ?? 0;

    reports.push({
      label: '5000 durable writes in OPFS',
      ok: n === 5000 && ms < 5000,
      detail: `${n} rows in ${ms.toFixed(0)} ms`,
    });
  } catch (error) {
    reports.push({
      label: '5000 durable writes in OPFS',
      ok: false,
      detail: String(error instanceof Error ? error.message : error),
    });
  }

  // Cold open on a warm database — the shape of the `PRD.md` s.79 budget.
  try {
    await client.send('close', {}, dbId);
    const start = performance.now();
    const reopened = (await client.send('open', { filename })) as { dbId: string };
    const counted = (await client.send(
      'exec',
      { sql: 'select count(*) as n from bulk', rowMode: 'object', resultRows: [] },
      reopened.dbId,
    )) as { resultRows: { n: number }[] };
    const ms = performance.now() - start;
    const n = counted.resultRows[0]?.n ?? 0;

    reports.push({
      label: 'cold open + read on a warm OPFS database',
      ok: n === 5000 && ms < 2000,
      detail: `${ms.toFixed(0)} ms to open and read ${n} rows`,
    });
  } catch (error) {
    reports.push({
      label: 'cold open on warm database',
      ok: false,
      detail: String(error instanceof Error ? error.message : error),
    });
  }

  client.terminate();
  return reports;
}
