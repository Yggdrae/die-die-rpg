import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import pg from 'pg';

/**
 * Minimal write-path backend for the spike.
 *
 * THE FINDING THIS FILE EXISTS FOR:
 *
 * PowerSync reads flow PostgreSQL -> client through the sync service. Writes do not. The
 * client queues a write locally and uploads it to a backend the application owns, and that
 * backend is the only thing that touches PostgreSQL.
 *
 * Consequence for `SyncedRepository.upsert(value, expectedVersion)`: while offline, the
 * local write succeeds and the version check has not happened yet. A conflict is detected
 * here, on upload, after the interface already told the user the change was applied. The
 * contract cannot promise a synchronous conflict result for an offline write.
 *
 * Node rather than Bun: Bun's SQL client hangs inside Bun.serve on Windows against the
 * WSL-hosted PostgreSQL, while working standalone. Throwaway code, not worth diagnosing.
 */

const DB_HOST = process.env.SPIKE_DB_HOST ?? '127.0.0.1';
const POWERSYNC_URL = process.env.SPIKE_POWERSYNC_URL ?? `http://${DB_HOST}:8080`;

const pool = new pg.Pool({
  connectionString: `postgres://rpg:rpg_dev_password@${DB_HOST}:5432/rpg`,
  max: 4,
});

const K_B64URL = 'c3Bpa2Utc2VjcmV0LWtleS1mb3Itd2F2ZS16ZXJvLW9ubHktMzJieXRlcw';
const secret = Buffer.from(K_B64URL, 'base64url');
const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

function makeToken(subject) {
  const now = Math.floor(Date.now() / 1000);
  const input = `${b64({ alg: 'HS256', typ: 'JWT', kid: 'spike' })}.${b64({
    sub: subject,
    aud: 'powersync-spike',
    iat: now,
    exp: now + 43200,
  })}`;
  return `${input}.${createHmac('sha256', secret).update(input).digest('base64url')}`;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json', ...CORS });
  res.end(JSON.stringify(body));
};

const readBody = (req) =>
  new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => resolve(data));
  });

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  try {
    if (url.pathname === '/token') {
      send(res, 200, {
        token: makeToken(url.searchParams.get('user') ?? 'spike-user'),
        endpoint: POWERSYNC_URL,
      });
      return;
    }

    if (url.pathname === '/entities') {
      const { rows } = await pool.query(
        'select id, campaign_id, name, version from entity order by id',
      );
      send(res, 200, { rows });
      return;
    }

    if (url.pathname === '/seed') {
      const name = url.searchParams.get('name') ?? 'Merchant';
      const id = url.searchParams.get('id') ?? 'npc-1';
      await pool.query(
        `insert into entity (id, campaign_id, name, version) values ($1,'spike',$2,1)
         on conflict (id) do update set name = excluded.name, version = entity.version + 1`,
        [id, name],
      );
      send(res, 200, { seeded: { id, name } });
      return;
    }

    if (url.pathname === '/upload' && req.method === 'POST') {
      const batch = JSON.parse((await readBody(req)) || '[]');
      const applied = [];

      for (const entry of batch) {
        if (entry.type !== 'entity') continue;
        const data = entry.data ?? {};

        if (entry.op === 'DELETE') {
          await pool.query('delete from entity where id = $1', [entry.id]);
          applied.push({ id: entry.id, op: 'DELETE', ok: true });
          continue;
        }

        const existing = await pool.query('select version from entity where id = $1', [entry.id]);

        if (existing.rows.length === 0) {
          await pool.query(
            'insert into entity (id, campaign_id, name, version) values ($1,$2,$3,1)',
            [entry.id, data.campaign_id ?? 'spike', data.name ?? ''],
          );
          applied.push({ id: entry.id, op: 'INSERT', version: 1, ok: true });
          continue;
        }

        const current = existing.rows[0].version;
        const expected = data.version;

        // The version check the offline client could not perform for itself.
        if (expected !== undefined && expected !== current) {
          applied.push({
            id: entry.id,
            op: 'CONFLICT',
            ok: false,
            expectedVersion: expected,
            actualVersion: current,
          });
          continue;
        }

        await pool.query('update entity set name = $1, version = $2 where id = $3', [
          data.name ?? '',
          current + 1,
          entry.id,
        ]);
        applied.push({ id: entry.id, op: 'UPDATE', version: current + 1, ok: true });
      }

      send(res, 200, { applied });
      return;
    }

    send(res, 404, { error: 'not found' });
  } catch (error) {
    send(res, 500, { error: String(error.message ?? error) });
  }
}).listen(3099, () => {
  console.log(`spike backend on http://localhost:3099 (db ${DB_HOST}, powersync ${POWERSYNC_URL})`);
});
