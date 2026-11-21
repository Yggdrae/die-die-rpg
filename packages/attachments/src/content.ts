import type { AttachmentMimeType } from './policy.ts';

/**
 * Content verification primitives used at finalization (`_db.md`, Upload Lifecycle): the actual
 * file signature must match the declared type, and keys never carry user input.
 */

/** Bytes needed to recognize every allowed type. */
export const SIGNATURE_BYTES = 12;

const PDF = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
const JPEG = [0xff, 0xd8, 0xff];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const RIFF = [0x52, 0x49, 0x46, 0x46];
const WEBP = [0x57, 0x45, 0x42, 0x50];

function startsWith(bytes: Uint8Array, prefix: readonly number[], offset = 0): boolean {
  return prefix.every((value, index) => bytes[offset + index] === value);
}

/**
 * Whether the leading bytes are the declared type's signature. Strict: a PDF header must start at
 * byte 0 (no leading junk), so an HTML or script payload labelled as an allowed type fails.
 */
export function matchesFileSignature(mime: AttachmentMimeType, head: Uint8Array): boolean {
  switch (mime) {
    case 'application/pdf':
      return startsWith(head, PDF);
    case 'image/jpeg':
      return startsWith(head, JPEG);
    case 'image/png':
      return startsWith(head, PNG);
    case 'image/webp':
      return startsWith(head, RIFF) && startsWith(head, WEBP, 8);
  }
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const OBJECT_KEY = new RegExp(`^campaigns/${UUID}/${UUID}/${UUID}$`);

/** `campaigns/<campaign>/<attachment>/<random>`: opaque, server-generated, never a filename. */
export function objectKeyFor(
  campaignId: string,
  attachmentId: string,
  random: string = crypto.randomUUID(),
): string {
  const key = `campaigns/${campaignId}/${attachmentId}/${random}`;
  if (!OBJECT_KEY.test(key)) throw new Error('invalid_object_key');
  return key;
}

export function isObjectKey(key: string): boolean {
  return OBJECT_KEY.test(key);
}

/** Streams an object once: SHA-256 (lowercase hex), byte count, and the leading signature bytes. */
export async function digestStream(chunks: AsyncIterable<Uint8Array>): Promise<{
  readonly checksum: string;
  readonly size: number;
  readonly head: Uint8Array;
}> {
  const hasher = new Bun.CryptoHasher('sha256');
  const head = new Uint8Array(SIGNATURE_BYTES);
  let size = 0;
  for await (const chunk of chunks) {
    if (size < SIGNATURE_BYTES) {
      head.set(chunk.subarray(0, SIGNATURE_BYTES - size), size);
    }
    size += chunk.byteLength;
    hasher.update(chunk);
  }
  return {
    checksum: hasher.digest('hex'),
    size,
    head: head.subarray(0, Math.min(size, SIGNATURE_BYTES)),
  };
}
