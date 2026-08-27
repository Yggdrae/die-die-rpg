import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { runOpfsTest } from './opfs-test.ts';
import { runSyncTest } from './sync-spike.ts';

/**
 * Task 10, search question: does SQLite/WASM as configured provide usable full-text
 * search over a campaign-sized dataset, and does it persist through OPFS?
 *
 * Features 14 and 20 both depend on the answer. A `no` is a valid wave-0 result: it moves
 * both features to a simpler prefix index. Throwaway code.
 */

type Line = { label: string; ok: boolean; detail: string };

const results: Line[] = [];
const out = document.getElementById('out') as HTMLElement;

function record(label: string, ok: boolean, detail: string): void {
  results.push({ label, ok, detail });
  out.innerHTML = results
    .map(
      (r) =>
        `<span class="${r.ok ? 'pass' : 'fail'}">${r.ok ? 'PASS' : 'FAIL'}</span>  ${r.label}\n        ${r.detail}`,
    )
    .join('\n');
  (window as unknown as { __spike: Line[] }).__spike = results;
}

/** Campaign-sized corpus: rules sections plus campaign content, ~5000 documents. */
function corpus(count: number): { id: string; type: string; title: string; body: string }[] {
  const nouns = ['warehouse', 'caravan', 'ledger', 'smuggler', 'seal', 'road', 'crate', 'lantern'];
  const verbs = ['recover', 'conceal', 'pursue', 'barter', 'repair', 'abandon', 'guard'];
  const docs = [];
  for (let i = 0; i < count; i += 1) {
    const noun = nouns[i % nouns.length];
    const verb = verbs[i % verbs.length];
    docs.push({
      id: `doc-${i}`,
      type: i % 3 === 0 ? 'rule' : 'entity',
      title: `${noun} ${i}`,
      body: `A passage about how to ${verb} the ${noun}. Healing rules mention rest and supplies. Entry ${i}.`,
    });
  }
  return docs;
}

async function main(): Promise<void> {
  let sqlite3: Awaited<ReturnType<typeof sqlite3InitModule>>;
  try {
    sqlite3 = await sqlite3InitModule({ print: () => {}, printErr: () => {} });
    record('sqlite-wasm loads', true, `version ${sqlite3.version.libVersion}`);
  } catch (error) {
    record('sqlite-wasm loads', false, String(error));
    return;
  }

  // --- OPFS availability -------------------------------------------------
  // Main thread only reports context. OPFS itself is exercised in the worker below,
  // because createSyncAccessHandle is not exposed on the main thread in Chromium and a
  // main-thread check reports a false negative.
  record(
    'cross-origin isolated',
    self.crossOriginIsolated === true,
    self.crossOriginIsolated
      ? 'COOP/COEP applied, OPFS SyncAccessHandle permitted'
      : 'NOT isolated — OPFS VFS will be unavailable',
  );

  // --- FTS5 compiled in --------------------------------------------------
  const db = new sqlite3.oo1.DB(':memory:');
  let fts5 = false;
  try {
    db.exec('create virtual table probe using fts5(body)');
    fts5 = true;
    record('FTS5 compiled in', true, 'virtual table created');
  } catch (error) {
    record('FTS5 compiled in', false, String(error));
  }

  if (!fts5) {
    db.close();
    return;
  }

  // --- Index a campaign-sized corpus -------------------------------------
  const docs = corpus(5000);
  db.exec('create virtual table docs using fts5(id, type, title, body)');

  const startIndex = performance.now();
  db.exec('begin');
  const insert = db.prepare('insert into docs(id, type, title, body) values (?,?,?,?)');
  for (const doc of docs) {
    insert.bind([doc.id, doc.type, doc.title, doc.body]).stepReset();
  }
  insert.finalize();
  db.exec('commit');
  const indexMs = performance.now() - startIndex;
  record('index 5000 documents', indexMs < 5000, `${indexMs.toFixed(0)} ms`);

  // --- Query latency -----------------------------------------------------
  const measure = (sql: string, bind: unknown[]): { ms: number; rows: number } => {
    const start = performance.now();
    const rows = db.selectObjects(sql, bind);
    return { ms: performance.now() - start, rows: rows.length };
  };

  const word = measure('select id from docs where docs match ? limit 20', ['warehouse']);
  record('word query', word.ms < 100, `${word.ms.toFixed(1)} ms, ${word.rows} rows`);

  const phrase = measure('select id from docs where docs match ? limit 20', ['"healing rules"']);
  record('phrase query', phrase.ms < 100, `${phrase.ms.toFixed(1)} ms, ${phrase.rows} rows`);

  // A GM types three letters of a name mid-session (feature 20 FR-007).
  const prefix = measure('select id from docs where docs match ? limit 20', ['ware*']);
  record('prefix query', prefix.ms < 100, `${prefix.ms.toFixed(1)} ms, ${prefix.rows} rows`);

  const ranked = measure('select id from docs where docs match ? order by rank limit 20', [
    'warehouse OR ledger',
  ]);
  record(
    'ranked boolean query',
    ranked.ms < 200,
    `${ranked.ms.toFixed(1)} ms, ${ranked.rows} rows`,
  );

  db.close();

  // --- OPFS, exercised through the worker1 classic worker ----------------
  try {
    const reports = await runOpfsTest();
    for (const report of reports) {
      record(report.label, report.ok, report.detail);
    }
  } catch (error) {
    record('OPFS test', false, String(error));
  }

  // --- Sync question -----------------------------------------------------
  const searchFailures = results.filter((r) => !r.ok);
  record(
    'SEARCH QUESTION',
    searchFailures.length === 0,
    searchFailures.length === 0
      ? 'GO — SQLite/WASM FTS5 + OPFS usable for features 03, 14 and 20'
      : `NO-GO on: ${searchFailures.map((f) => f.label).join(', ')}`,
  );

  const before = results.length;
  try {
    const syncReports = await runSyncTest();
    for (const report of syncReports) {
      record(report.label, report.ok, report.detail);
    }
  } catch (error) {
    record('sync test', false, String(error));
  }

  const syncFailures = results.slice(before).filter((r) => !r.ok);
  record(
    'SYNC QUESTION',
    syncFailures.length === 0,
    syncFailures.length === 0
      ? 'GO — offline write reaches PostgreSQL and back through PowerSync'
      : `NO-GO on: ${syncFailures.map((f) => f.label).join(', ')}`,
  );
}

main().catch((error) => record('spike crashed', false, String(error)));
