import { describe, expect, test } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import {
  digestStream,
  isObjectKey,
  matchesFileSignature,
  objectKeyFor,
  SIGNATURE_BYTES,
} from './content.ts';
import { AttachmentMetadata, toAttachmentRef } from './model.ts';
import {
  ATTACHMENT_MIME_TYPES,
  checkFilePolicy,
  isSafeFilename,
  MAX_ATTACHMENT_BYTES,
  renderKindFor,
} from './policy.ts';
import { contentDisposition } from './storage.ts';
import { CAMPAIGN, fileBytes, sha256 } from './testing.ts';

const CHECKSUM = 'a'.repeat(64);
const file = (overrides: Partial<Parameters<typeof checkFilePolicy>[0]> = {}) => ({
  filename: 'map.png',
  mime: 'image/png',
  size: 1024,
  checksum: CHECKSUM,
  ...overrides,
});

describe('file policy (FR-006)', () => {
  // Scenario Outline: Every MVP MIME type is accepted at the policy boundary.
  for (const mime of ['application/pdf', 'image/jpeg', 'image/png', 'image/webp']) {
    test(`accepts ${mime}`, () => {
      expect(checkFilePolicy(file({ mime }))).toBeUndefined();
    });
  }

  // Scenario Outline: Every unlisted MIME type is rejected before upload.
  for (const mime of [
    'image/svg+xml',
    'audio/mpeg',
    'video/mp4',
    'text/markdown',
    'text/plain',
    'application/octet-stream',
    'text/html',
    'IMAGE/PNG',
    'image/png; charset=utf-8',
  ]) {
    test(`rejects ${mime}`, () => {
      expect(checkFilePolicy(file({ mime }))).toBe('unsupported_file_type');
    });
  }

  test('a file exactly at the size limit is accepted; one byte over is rejected', () => {
    expect(MAX_ATTACHMENT_BYTES).toBe(25 * 1024 * 1024);
    expect(checkFilePolicy(file({ size: MAX_ATTACHMENT_BYTES }))).toBeUndefined();
    expect(checkFilePolicy(file({ size: MAX_ATTACHMENT_BYTES + 1 }))).toBe('file_too_large');
  });

  test('empty, fractional and unsafe sizes are rejected', () => {
    expect(checkFilePolicy(file({ size: 0 }))).toBe('empty_file');
    expect(checkFilePolicy(file({ size: 1.5 }))).toBe('empty_file');
    expect(checkFilePolicy(file({ size: Number.MAX_SAFE_INTEGER + 2 }))).toBe('empty_file');
  });

  test('an unsupported oversized file reports the type first', () => {
    expect(checkFilePolicy(file({ mime: 'video/mp4', size: MAX_ATTACHMENT_BYTES * 4 }))).toBe(
      'unsupported_file_type',
    );
  });

  test('checksums are lowercase hex SHA-256 only', () => {
    expect(checkFilePolicy(file({ checksum: 'A'.repeat(64) }))).toBe('invalid_checksum');
    expect(checkFilePolicy(file({ checksum: 'a'.repeat(63) }))).toBe('invalid_checksum');
    expect(checkFilePolicy(file({ checksum: Buffer.alloc(32).toString('base64') }))).toBe(
      'invalid_checksum',
    );
  });

  test('filenames: 1–255 code points, no controls or separators, not blank or a dot segment', () => {
    for (const safe of [
      'map.png',
      'Mapa do Porto – versão 2.pdf',
      '龍の地図.webp',
      'é'.repeat(255),
    ]) {
      expect({ safe, ok: isSafeFilename(safe) }).toEqual({ safe, ok: true });
    }
    for (const unsafe of [
      '',
      '   ',
      '.',
      '..',
      '../etc/passwd',
      'a/b.png',
      'a\\b.png',
      'tab\tname.png',
      'nul\u0000.png',
      'del\u007f.png',
      'c1\u0085.png',
      'é'.repeat(256),
      '😀'.repeat(256),
    ]) {
      expect({ unsafe, ok: isSafeFilename(unsafe) }).toEqual({ unsafe, ok: false });
    }
    expect(isSafeFilename('😀'.repeat(255))).toBe(true);
  });

  test('images render inert; PDFs are documents', () => {
    expect(ATTACHMENT_MIME_TYPES.map(renderKindFor)).toEqual([
      'document',
      'image',
      'image',
      'image',
    ]);
  });
});

describe('content verification primitives', () => {
  test('each allowed type is recognized by its signature only', () => {
    for (const mime of ATTACHMENT_MIME_TYPES) {
      const head = fileBytes(mime).subarray(0, SIGNATURE_BYTES);
      for (const declared of ATTACHMENT_MIME_TYPES) {
        expect({ mime, declared, ok: matchesFileSignature(declared, head) }).toEqual({
          mime,
          declared,
          ok: declared === mime,
        });
      }
    }
  });

  test('active or malformed content labelled as an allowed type fails', () => {
    const html = new TextEncoder().encode('<html><script>alert(1)</script></html>');
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');
    const junkPdf = new TextEncoder().encode('\n<script>x</script>%PDF-1.7');
    const riffWave = new TextEncoder().encode('RIFF\u0000\u0000\u0000\u0000WAVEfmt ');
    for (const mime of ATTACHMENT_MIME_TYPES) {
      expect(matchesFileSignature(mime, html)).toBe(false);
      expect(matchesFileSignature(mime, svg)).toBe(false);
    }
    expect(matchesFileSignature('application/pdf', junkPdf)).toBe(false);
    expect(matchesFileSignature('image/webp', riffWave)).toBe(false);
    expect(matchesFileSignature('image/png', new Uint8Array())).toBe(false);
  });

  test('object keys are opaque and never carry a filename', () => {
    const key = objectKeyFor(CAMPAIGN, '00000000-0000-4000-8000-000000000123');
    expect(key).toMatch(/^campaigns\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/);
    expect(isObjectKey(key)).toBe(true);
    expect(objectKeyFor(CAMPAIGN, '00000000-0000-4000-8000-000000000123')).not.toBe(key);
    expect(() => objectKeyFor(CAMPAIGN, '../map.png')).toThrow('invalid_object_key');
    expect(isObjectKey(`${key}/map.png`)).toBe(false);
  });

  test('the streamed digest equals a one-shot SHA-256 across chunk boundaries', async () => {
    const bytes = fileBytes('image/png', 1000);
    async function* chunks() {
      for (let offset = 0; offset < bytes.length; offset += 3)
        yield bytes.subarray(offset, offset + 3);
    }
    const digest = await digestStream(chunks());
    expect(digest.checksum).toBe(sha256(bytes));
    expect(digest.size).toBe(1000);
    expect([...digest.head]).toEqual([...bytes.subarray(0, SIGNATURE_BYTES)]);
  });

  test('download disposition cannot break out of the header', () => {
    expect(contentDisposition('inline', 'x.pdf')).toBe('inline');
    const value = contentDisposition('attachment', 'a"b;\r\nSet-Cookie: x=1 é.pdf');
    expect(value).not.toMatch(/[\r\n]/);
    expect(value.startsWith('attachment; filename="a_b__')).toBe(true);
    expect(value).toContain("filename*=UTF-8''a%22b%3B%0D%0ASet-Cookie%3A%20x%3D1%20%C3%A9.pdf");
  });

  test('public metadata is an AttachmentRef superset with no key, URL or bytes', () => {
    const properties = Object.keys(AttachmentMetadata.properties).sort();
    expect(properties).toEqual(
      [
        'attachmentId',
        'campaignId',
        'checksum',
        'createdAt',
        'createdBy',
        'filename',
        'finalizedAt',
        'mime',
        'owner',
        'size',
        'status',
        'updatedAt',
        'updatedBy',
        'version',
        'visibility',
      ].sort(),
    );
    const metadata = {
      attachmentId: '00000000-0000-4000-8000-000000000123',
      campaignId: CAMPAIGN,
      owner: { resourceClass: 'fixture_note', resourceId: CAMPAIGN },
      filename: 'map.png',
      mime: 'image/png' as const,
      size: 10,
      checksum: CHECKSUM,
      status: 'ready' as const,
      visibility: { mode: 'gm_only' as const },
      version: 1,
      createdAt: '2026-10-27T00:00:00.000Z',
      createdBy: CAMPAIGN,
      updatedAt: '2026-10-27T00:00:00.000Z',
      updatedBy: CAMPAIGN,
      finalizedAt: '2026-10-27T00:00:00.000Z',
    };
    expect(Value.Check(AttachmentMetadata, metadata)).toBe(true);
    expect(Value.Check(AttachmentMetadata, { ...metadata, objectKey: 'campaigns/x' })).toBe(false);
    expect(Value.Check(AttachmentMetadata, { ...metadata, bytes: 'AAAA' })).toBe(false);
    expect(toAttachmentRef(metadata)).toEqual({
      attachmentId: metadata.attachmentId,
      mime: 'image/png',
      size: 10,
      status: 'ready',
    });
  });
});
