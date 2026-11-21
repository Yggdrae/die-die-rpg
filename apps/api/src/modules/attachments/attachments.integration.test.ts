import { afterAll, describe, expect, test } from 'bun:test';
import { connectAttachmentDatabase, PostgresAttachmentRepository } from '@rpg/attachments/postgres';
import { BunS3ObjectStorage, s3ConfigFromEnv } from '@rpg/attachments/s3';
import { CONTENT_ATTACHMENT_OWNER_CLASSES } from '@rpg/content';
import { FIXTURE_SYSTEM_DEFINITION } from '@rpg/fixtures';
import postgres from 'postgres';
import { buildRuntimeApp } from '../../runtime.ts';
import { CASEY, GM, NOTE, noteId, ROWAN, STRANGER } from '../authorization/test-fixture.ts';
import { attachmentApp, CAMPAIGN, headersFor, PDF, PNG, uploadBody } from './test-support.ts';

/**
 * Tasks 03–04 against the real stores: PostgreSQL metadata and the S3-compatible provider (MinIO).
 * The client's direct upload is a real `fetch` to the signed URL; no API request or response
 * carries file bytes. Skipped when either store is unreachable.
 */

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const storage = new BunS3ObjectStorage(s3ConfigFromEnv(process.env));
const connection = databaseUrl === undefined ? undefined : connectAttachmentDatabase(databaseUrl);
const sql = databaseUrl === undefined ? undefined : postgres(databaseUrl, { max: 1 });
const available = await (async () => {
  if (connection === undefined || sql === undefined) return false;
  try {
    await sql`select 1 from attachments limit 1`;
    await storage.inspect(`campaigns/${CAMPAIGN}/${CAMPAIGN}/${CAMPAIGN}`);
    return true;
  } catch {
    return false;
  }
})();
const keys: string[] = [];

afterAll(async () => {
  if (connection === undefined || sql === undefined) return;
  if (available) {
    for (const key of keys) await storage.delete(key);
    await sql`delete from attachments where campaign_id = ${CAMPAIGN}`;
  }
  await connection.close();
  await sql.end({ timeout: 1 });
});

describe.skipIf(!available)('attachments over HTTP with PostgreSQL and MinIO', () => {
  function harness() {
    if (connection === undefined) throw new Error('database unavailable');
    const built = attachmentApp({
      storage,
      repository: new PostgresAttachmentRepository(connection.db),
    });
    built.context.notes.put({ id: noteId(1), visibility: { mode: 'everyone' } });
    return built;
  }

  async function upload(
    built: ReturnType<typeof harness>,
    bytes: Uint8Array,
    overrides: Parameters<typeof uploadBody>[1] = {},
    sent: Uint8Array = bytes,
  ) {
    const body = uploadBody(bytes, overrides);
    const permission = await built.app.inject({
      method: 'POST',
      url: `/campaigns/${CAMPAIGN}/attachments/uploads`,
      headers: headersFor(GM),
      payload: body as unknown as Record<string, unknown>,
    });
    expect(permission.statusCode).toBe(201);
    const { attachment, upload: grant } = permission.json();
    const row = await built.repository.find(CAMPAIGN, attachment.attachmentId);
    if (row !== undefined) keys.push(row.objectKey);
    const put = await fetch(grant.url, {
      method: grant.method,
      headers: grant.headers,
      body: sent,
    });
    const finalize = () =>
      built.app.inject({
        method: 'POST',
        url: `/campaigns/${CAMPAIGN}/attachments/${attachment.attachmentId}/finalize`,
        headers: headersFor(GM),
        payload: { size: body.size, checksum: body.checksum },
      });
    return { id: attachment.attachmentId as string, body, put, finalize, permission };
  }

  // Scenario: Binary content goes directly to the granted upload destination.
  test('bytes go to object storage only; finalize, list and a signed read round-trip them', async () => {
    const built = harness();
    const { id, body, put, finalize, permission } = await upload(built, PDF, {
      mime: 'application/pdf',
      filename: 'letter.pdf',
    });
    expect(put.status).toBe(200);
    expect(permission.body.length).toBeLessThan(2000);
    // Not visible before finalization.
    const before = await built.app.inject({
      method: 'GET',
      url: `/campaigns/${CAMPAIGN}/resources/${NOTE}/${noteId(1)}/attachments`,
      headers: headersFor(GM),
    });
    expect(before.json() as unknown).toEqual({ items: [] });
    const ready = await finalize();
    expect(ready.statusCode).toBe(200);
    expect((await finalize()).json()).toEqual(ready.json());
    const listed = await built.app.inject({
      method: 'GET',
      url: `/campaigns/${CAMPAIGN}/resources/${NOTE}/${noteId(1)}/attachments`,
      headers: headersFor(CASEY),
    });
    expect(listed.json().items.map((item: { attachmentId: string }) => item.attachmentId)).toEqual([
      id,
    ]);
    const grant = await built.app.inject({
      method: 'GET',
      url: `/campaigns/${CAMPAIGN}/attachments/${id}/read`,
      headers: headersFor(CASEY),
    });
    const response = await fetch(grant.json().url, {
      headers: { origin: 'http://127.0.0.1:4173' },
    });
    expect(response.headers.get('content-type')).toBe('application/pdf');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(new Bun.CryptoHasher('sha256').update(bytes).digest('hex')).toBe(body.checksum);
    // Metadata only in PostgreSQL: the row is small and holds the digest, not the content.
    if (sql === undefined) return;
    const [row] = await sql<{ checksum: number; text: string }[]>`
      select octet_length(verified_checksum) as checksum, row_to_json(attachments.*)::text as text
      from attachments where id = ${id}
    `;
    expect(Number(row?.checksum)).toBe(32);
    expect(row?.text).not.toContain('PDF-1.7');
    expect(row?.text).not.toContain('JavaScript');
  });

  test('hostile content uploaded under an image type never becomes ready', async () => {
    const built = harness();
    const html = new TextEncoder().encode('<html><script>alert(document.cookie)</script></html>');
    const { id, finalize } = await upload(built, html, { mime: 'image/png' });
    const result = await finalize();
    expect([result.statusCode, result.json().code]).toEqual([422, 'signature_mismatch']);
    expect((await built.repository.find(CAMPAIGN, id))?.status).toBe('failed');
    const row = await built.repository.find(CAMPAIGN, id);
    expect(row === undefined ? undefined : await storage.inspect(row.objectKey)).toBeUndefined();
  });

  test('a client that swaps bytes after permission is caught by the stored checksum', async () => {
    const built = harness();
    const swapped = PNG.map((value, index) => (index === 50 ? value ^ 0xff : value));
    // Omits the checksum header the grant asked for, so the provider cannot refuse the body.
    const body = uploadBody(PNG);
    const permission = await built.app.inject({
      method: 'POST',
      url: `/campaigns/${CAMPAIGN}/attachments/uploads`,
      headers: headersFor(GM),
      payload: body as unknown as Record<string, unknown>,
    });
    const { attachment, upload: grant } = permission.json();
    const row = await built.repository.find(CAMPAIGN, attachment.attachmentId);
    if (row !== undefined) keys.push(row.objectKey);
    await fetch(grant.url, { method: 'PUT', body: swapped });
    const result = await built.app.inject({
      method: 'POST',
      url: `/campaigns/${CAMPAIGN}/attachments/${attachment.attachmentId}/finalize`,
      headers: headersFor(GM),
      payload: { size: body.size, checksum: body.checksum },
    });
    expect([result.statusCode, result.json().code]).toEqual([422, 'checksum_mismatch']);
  });

  test('a player-targeted attachment reads only for its target; others get the missing shape', async () => {
    const built = harness();
    const { id, finalize } = await upload(built, PNG, {
      visibility: { mode: 'players', playerIds: [ROWAN] },
    });
    expect((await finalize()).statusCode).toBe(200);
    const readAs = (userId: string, attachmentId = id) =>
      built.app.inject({
        method: 'GET',
        url: `/campaigns/${CAMPAIGN}/attachments/${attachmentId}/read`,
        headers: headersFor(userId),
      });
    expect((await readAs(ROWAN)).statusCode).toBe(200);
    const missing = await readAs(CASEY, '00000000-0000-4000-8000-00000000dead');
    for (const userId of [CASEY, STRANGER]) {
      const denied = await readAs(userId);
      expect([denied.statusCode, denied.body]).toEqual([missing.statusCode, missing.body]);
    }
  });
});

describe.skipIf(!available)(
  'runtime composition (feature 16 entities are the only owner class)',
  () => {
    test('routes are mounted, startup passes, and every other owner class is denied safely', async () => {
      if (databaseUrl === undefined) return;
      const origin = 'https://table.invalid';
      const app = buildRuntimeApp({
        databaseUrl,
        allowedOrigin: origin,
        production: false,
        powerSyncEndpoint: 'http://localhost:8080',
        powerSyncJwtSecret: 'ZGV2ZWxvcG1lbnQtb25seS1wb3dlcnN5bmMta2V5LTMyIQ',
        systems: [FIXTURE_SYSTEM_DEFINITION],
        logger: false,
        attachments: { storage, ownerClasses: CONTENT_ATTACHMENT_OWNER_CLASSES },
      });
      try {
        await app.ready();
        const account = await app.inject({
          method: 'POST',
          url: '/auth/accounts',
          payload: {
            username: `att_${crypto.randomUUID().slice(0, 8)}`,
            password: 'correct horse battery staple',
          },
        });
        const raw = account.headers['set-cookie'];
        const cookie = ((Array.isArray(raw) ? raw[0] : raw) ?? '').split(';')[0] ?? '';
        const campaignId = crypto.randomUUID();
        const created = await app.inject({
          method: 'POST',
          url: '/campaigns',
          headers: { cookie, origin },
          payload: {
            id: campaignId,
            system: FIXTURE_SYSTEM_DEFINITION.summary.ref,
            gameMode: 'standard',
            options: {},
            moduleIds: [],
            name: 'Attachments',
            description: '',
          },
        });
        expect(created.statusCode).toBe(201);
        const body = uploadBody(PNG, {
          owner: { resourceClass: 'campaign', resourceId: campaignId },
        });
        const upload = await app.inject({
          method: 'POST',
          url: `/campaigns/${campaignId}/attachments/uploads`,
          headers: { cookie, origin },
          payload: body as unknown as Record<string, unknown>,
        });
        const listing = await app.inject({
          method: 'GET',
          url: `/campaigns/${campaignId}/resources/campaign/${campaignId}/attachments`,
          headers: { cookie },
        });
        const unknown = await app.inject({
          method: 'GET',
          url: `/campaigns/${campaignId}/resources/npc/${campaignId}/attachments`,
          headers: { cookie },
        });
        for (const response of [upload, listing, unknown]) {
          expect([response.statusCode, response.json()]).toEqual([
            404,
            { code: 'not_found_or_forbidden', message: 'Not found.' },
          ]);
        }
        const anonymous = await app.inject({
          method: 'GET',
          url: `/campaigns/${campaignId}/attachments/${campaignId}/read`,
        });
        expect(anonymous.statusCode).toBe(401);
      } finally {
        await app.close();
      }
    });
  },
);
