import { afterAll, describe, expect, test } from 'bun:test';
import { AttachmentService } from '../../application.ts';
import { objectKeyFor } from '../../content.ts';
import { MemoryAttachmentRepository } from '../../memory.ts';
import {
  CAMPAIGN,
  FixtureAuthorizer,
  fileBytes,
  GM,
  NOTE,
  ownerId,
  sha256,
} from '../../testing.ts';
import { BunS3ObjectStorage, s3ConfigFromEnv } from './bun-s3-storage.ts';

/**
 * Task 01 evidence against the local S3-compatible provider (MinIO via `compose.yaml`, bucket and
 * signing user from the `minio-bucket` one-shot). Skipped when the provider is unreachable.
 */

const config = s3ConfigFromEnv(process.env);
const APP_ORIGIN = 'http://127.0.0.1:4173';
const storage = new BunS3ObjectStorage(config);
const reachable = await (async () => {
  try {
    await storage.inspect(objectKeyFor(CAMPAIGN, crypto.randomUUID()));
    return true;
  } catch {
    return false;
  }
})();
const created: string[] = [];

afterAll(async () => {
  if (!reachable) return;
  for (const key of created) await storage.delete(key);
});

function key(): string {
  const value = objectKeyFor(CAMPAIGN, crypto.randomUUID());
  created.push(value);
  return value;
}

async function upload(bytes: Uint8Array, mime: 'image/png' | 'application/pdf' = 'image/png') {
  const target = key();
  const grant = await storage.createUploadGrant({
    key: target,
    contentType: mime,
    size: bytes.byteLength,
    checksum: sha256(bytes),
    expiresInSeconds: 600,
  });
  const response = await fetch(grant.url, {
    method: grant.method,
    headers: grant.headers,
    body: bytes,
  });
  return { target, grant, response };
}

/** The provider's current time (epoch seconds, truncated) from its HTTP `Date` header. */
async function providerSeconds(): Promise<number> {
  const date = (await fetch(`${config.endpoint}/${config.bucket}`)).headers.get('date');
  if (date === null) throw new Error('provider sent no Date header');
  return Date.parse(date) / 1000;
}

async function untilProviderSeconds(target: number): Promise<void> {
  while ((await providerSeconds()) < target) await Bun.sleep(100);
}

/** `X-Amz-Date` (`20261030T214000Z`) as epoch seconds. */
function signedSeconds(stamp: string): number {
  const iso = stamp.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z');
  return Date.parse(iso) / 1000;
}

describe.skipIf(!reachable)('Bun.S3Client adapter against MinIO (task 01)', () => {
  test('a bound upload grant stores the bytes; inspect and streamed read return them', async () => {
    const bytes = fileBytes('image/png', 5000);
    const { target, grant, response } = await upload(bytes);
    expect(response.status).toBe(200);
    expect(grant.method).toBe('PUT');
    expect(Object.keys(grant.headers).sort()).toEqual(['content-type', 'x-amz-checksum-sha256']);
    expect(grant.url).not.toContain(config.secretAccessKey);
    expect(grant.url).toContain('X-Amz-Expires=600');
    expect(await storage.inspect(target)).toEqual({ size: 5000 });
    const chunks: Uint8Array[] = [];
    for await (const chunk of storage.read(target)) chunks.push(chunk);
    expect(sha256(Buffer.concat(chunks))).toBe(sha256(bytes));
  });

  test('the provider rejects a body that does not match the granted checksum header', async () => {
    const bytes = fileBytes('image/png');
    const target = key();
    const grant = await storage.createUploadGrant({
      key: target,
      contentType: 'image/png',
      size: bytes.byteLength,
      checksum: sha256(bytes),
      expiresInSeconds: 600,
    });
    const tampered = bytes.slice();
    tampered[30] = (tampered[30] ?? 0) ^ 0xff;
    const response = await fetch(grant.url, {
      method: 'PUT',
      headers: grant.headers,
      body: tampered,
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('XAmzContentChecksumMismatch');
    expect(await storage.inspect(target)).toBeUndefined();
  });

  test('unbound conditions are documented: a client may omit headers or change the length', async () => {
    const bytes = fileBytes('image/png');
    const target = key();
    const grant = await storage.createUploadGrant({
      key: target,
      contentType: 'image/png',
      size: bytes.byteLength,
      checksum: sha256(bytes),
      expiresInSeconds: 600,
    });
    const other = new TextEncoder().encode('<html><script>alert(1)</script></html>');
    const response = await fetch(grant.url, {
      method: 'PUT',
      headers: { 'content-type': 'text/html' },
      body: other,
    });
    // Accepted by the provider: finalization's HEAD/SHA-256/signature checks are the compensation.
    expect(response.status).toBe(200);
    expect(await storage.inspect(target)).toEqual({ size: other.byteLength });
  });

  test('read grants force the declared type and disposition, and are signed', async () => {
    const html = new TextEncoder().encode('<html><script>alert(1)</script></html>');
    const target = key();
    const put = await storage.createUploadGrant({
      key: target,
      contentType: 'image/png',
      size: html.byteLength,
      checksum: sha256(html),
      expiresInSeconds: 600,
    });
    await fetch(put.url, { method: 'PUT', headers: { 'content-type': 'text/html' }, body: html });
    const read = await storage.createReadGrant({
      key: target,
      contentType: 'image/png',
      disposition: 'inline',
      expiresInSeconds: 300,
    });
    const response = await fetch(read.url, { headers: { origin: APP_ORIGIN } });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('content-disposition')).toBe('inline');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('access-control-allow-origin')).toBe(APP_ORIGIN);
    const tampered = await fetch(read.url.replace('image%2Fpng', 'text%2Fhtml'));
    expect(tampered.status).toBe(403);
    const download = await storage.createReadGrant({
      key: target,
      contentType: 'application/pdf',
      disposition: 'attachment',
      filename: 'Mapa do porto.pdf',
      expiresInSeconds: 300,
    });
    const downloaded = await fetch(download.url);
    expect(downloaded.headers.get('content-disposition')).toBe(
      `attachment; filename="Mapa do porto.pdf"; filename*=UTF-8''Mapa%20do%20porto.pdf`,
    );
  });

  // The URL is signed with this host's clock and judged by the provider's, which can differ (a WSL
  // VM clock runs seconds ahead of Windows). So every instant below is read from the provider.
  test('a read URL ages out at its declared expiry on the provider clock', async () => {
    const { target } = await upload(fileBytes('image/png'));
    const ahead = (await providerSeconds()) - Date.now() / 1000;
    const lifetime = 6 + Math.max(0, Math.ceil(ahead));
    const read = await storage.createReadGrant({
      key: target,
      contentType: 'image/png',
      disposition: 'inline',
      expiresInSeconds: lifetime,
    });
    const query = new URL(read.url).searchParams;
    expect(query.get('X-Amz-Expires')).toBe(String(lifetime));
    const expiry = signedSeconds(query.get('X-Amz-Date') ?? '') + lifetime;
    expect((await fetch(read.url)).status).toBe(200);
    await untilProviderSeconds(expiry - 2);
    const nearExpiry = await fetch(read.url);
    // That VM clock also jumps seconds forward, possibly past the expiry during this wait; only a
    // provider still before the expiry after the fetch proves the URL had to be valid.
    if ((await providerSeconds()) < expiry) expect(nearExpiry.status).toBe(200);
    // `Date` truncates to whole seconds: the provider is past the expiry from here on.
    await untilProviderSeconds(expiry + 1);
    const expired = await fetch(read.url);
    expect(expired.status).toBe(403);
    expect(await expired.text()).toContain('Request has expired');
  }, 60_000);

  test('the bucket is private: no anonymous read or listing, no foreign CORS origin', async () => {
    const { target } = await upload(fileBytes('image/png'));
    expect((await fetch(`${config.endpoint}/${config.bucket}/${target}`)).status).toBe(403);
    expect((await fetch(`${config.endpoint}/${config.bucket}?list-type=2`)).status).toBe(403);
    const read = await storage.createReadGrant({
      key: target,
      contentType: 'image/png',
      disposition: 'inline',
      expiresInSeconds: 300,
    });
    const foreign = await fetch(read.url, { headers: { origin: 'https://evil.invalid' } });
    expect(foreign.headers.get('access-control-allow-origin')).toBeNull();
    const preflight = await fetch(read.url, {
      method: 'OPTIONS',
      headers: {
        origin: APP_ORIGIN,
        'access-control-request-method': 'PUT',
        'access-control-request-headers': 'content-type,x-amz-checksum-sha256',
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe(APP_ORIGIN);
  });

  test('delete is idempotent and grant lifetimes are bounded', async () => {
    const { target } = await upload(fileBytes('image/png'));
    await storage.delete(target);
    await storage.delete(target);
    expect(await storage.inspect(target)).toBeUndefined();
    let rejected = 0;
    for (const seconds of [0, 3601, 1.5]) {
      try {
        await storage.createReadGrant({
          key: target,
          contentType: 'image/png',
          disposition: 'inline',
          expiresInSeconds: seconds,
        });
      } catch {
        rejected += 1;
      }
    }
    expect(rejected).toBe(3);
  });

  test('wrong credentials surface as unavailable, never as a leaked secret', async () => {
    const broken = new BunS3ObjectStorage({ ...config, secretAccessKey: 'wrong-secret-value' });
    let message = '';
    try {
      await broken.inspect(objectKeyFor(CAMPAIGN, crypto.randomUUID()));
    } catch (error) {
      message = `${(error as Error).name}: ${(error as Error).message}`;
    }
    expect(message).toBe('ObjectStorageUnavailable: object storage unavailable: inspect');
  });

  test('end to end: request, direct upload, verified finalize, signed read', async () => {
    const repository = new MemoryAttachmentRepository();
    const authorizer = new FixtureAuthorizer();
    authorizer.putOwner(NOTE, ownerId(1), { mode: 'everyone' });
    const service = new AttachmentService({
      repository,
      storage,
      authorizer,
      members: authorizer.members,
      ownerClasses: [NOTE],
    });
    const bytes = fileBytes('application/pdf', 2048);
    const body = {
      owner: { resourceClass: NOTE, resourceId: ownerId(1) },
      filename: 'letter.pdf',
      mime: 'application/pdf',
      size: bytes.byteLength,
      checksum: sha256(bytes),
      visibility: { mode: 'everyone' as const },
    };
    const permission = await service.requestUpload(GM, CAMPAIGN, body);
    if (!permission.ok) throw new Error(permission.error);
    const { upload } = permission.value;
    const put = await fetch(upload.url, {
      method: upload.method,
      headers: upload.headers,
      body: bytes,
    });
    expect(put.status).toBe(200);
    const row = repository.rows.get(permission.value.attachment.attachmentId);
    if (row !== undefined) created.push(row.objectKey);
    const ready = await service.finalize(
      GM,
      CAMPAIGN,
      permission.value.attachment.attachmentId,
      body,
    );
    expect(ready.ok).toBe(true);
    const grant = await service.issueRead(GM, CAMPAIGN, permission.value.attachment.attachmentId);
    if (!grant.ok) throw new Error(grant.error);
    const response = await fetch(grant.value.url);
    expect(response.headers.get('content-type')).toBe('application/pdf');
    expect(sha256(new Uint8Array(await response.arrayBuffer()))).toBe(body.checksum);
  });

  test('task 06: server-side listing pages keys under a prefix and deletion converges', async () => {
    const campaign = crypto.randomUUID();
    const keys: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const target = objectKeyFor(campaign, crypto.randomUUID());
      created.push(target);
      keys.push(target);
      const bytes = fileBytes('image/png');
      const grant = await storage.createUploadGrant({
        key: target,
        contentType: 'image/png',
        size: bytes.byteLength,
        checksum: sha256(bytes),
        expiresInSeconds: 600,
      });
      expect(
        (await fetch(grant.url, { method: 'PUT', headers: grant.headers, body: bytes })).ok,
      ).toBe(true);
    }
    const prefix = `campaigns/${campaign}/`;
    const first = await storage.list({ prefix, limit: 2 });
    expect(first.keys).toHaveLength(2);
    expect(first.after).toBeDefined();
    const second = await storage.list({
      prefix,
      limit: 2,
      ...(first.after ? { after: first.after } : {}),
    });
    expect(second).toEqual({ keys: [keys.sort()[2] ?? ''] });
    expect([...first.keys, ...second.keys]).toEqual(keys.sort());
    for (const target of keys) await storage.delete(target);
    // A missing object is success, and the listing converges to empty.
    await storage.delete(keys[0] ?? '');
    expect(await storage.list({ prefix, limit: 10 })).toEqual({ keys: [] });
  });
});
