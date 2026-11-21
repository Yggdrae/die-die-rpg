import { PACKAGE_LIMITS, type PackageLimits } from './limits.ts';
import { isSafeEntryPath } from './paths.ts';

/**
 * Minimal deterministic ZIP (PKWARE APPNOTE 6.3) for `.rpgpack`: no ZIP64, no encryption, no
 * comments, no extra fields on write, fixed 1980-01-01 timestamps. Methods: stored (0) and raw
 * deflate (8) through the web-standard `CompressionStream`, so the same code runs on the server
 * and in a browser worker.
 *
 * The reader trusts nothing: it validates the central directory against the limits and path rules
 * before any entry is decompressed, and decompression is bounded by the declared size as it runs.
 */

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;
const LOCAL_HEADER = 30;
const CENTRAL_HEADER = 46;
const END_RECORD = 22;
const UTF8_FLAG = 0x0800;
const DATA_DESCRIPTOR_FLAG = 0x0008;
const ENCRYPTED_FLAG = 0x0001;
const DOS_DATE_1980_01_01 = (0 << 9) | (1 << 5) | 1;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;
const UNIX_HOST = 3;
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const DOS_DIRECTORY = 0x10;

export type ZipCompression = 'store' | 'deflate';

export interface ZipInputEntry {
  readonly path: string;
  readonly data: Uint8Array;
}

/**
 * Writes entries in the given order. Returns the archive as parts so a caller can stream it
 * without concatenating a second copy. Deflate falls back to stored for any entry whose ratio
 * would exceed the reader's limit, so a package always passes its own inspector.
 */
export async function writeZip(
  entries: readonly ZipInputEntry[],
  options: { readonly compression?: ZipCompression; readonly limits?: PackageLimits } = {},
): Promise<Uint8Array[]> {
  const limits = options.limits ?? PACKAGE_LIMITS;
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!isSafeEntryPath(entry.path)) throw new Error('zip_invalid_path');
    if (seen.has(entry.path.toLowerCase())) throw new Error('zip_duplicate_path');
    seen.add(entry.path.toLowerCase());
    const name = new TextEncoder().encode(entry.path);
    const crc = crc32(entry.data);
    let method = METHOD_STORED;
    let body = entry.data;
    if (options.compression === 'deflate' && entry.data.length > 0) {
      const deflated = await deflateRaw(entry.data);
      if (
        deflated.length < entry.data.length &&
        entry.data.length <= deflated.length * limits.maxCompressionRatio
      ) {
        method = METHOD_DEFLATE;
        body = deflated;
      }
    }
    const local = new DataView(new ArrayBuffer(LOCAL_HEADER));
    local.setUint32(0, LOCAL_SIGNATURE, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, UTF8_FLAG, true);
    local.setUint16(8, method, true);
    local.setUint16(10, 0, true);
    local.setUint16(12, DOS_DATE_1980_01_01, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, body.length, true);
    local.setUint32(22, entry.data.length, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    parts.push(new Uint8Array(local.buffer), name, body);

    const header = new DataView(new ArrayBuffer(CENTRAL_HEADER));
    header.setUint32(0, CENTRAL_SIGNATURE, true);
    header.setUint16(4, 20, true);
    header.setUint16(6, 20, true);
    header.setUint16(8, UTF8_FLAG, true);
    header.setUint16(10, method, true);
    header.setUint16(12, 0, true);
    header.setUint16(14, DOS_DATE_1980_01_01, true);
    header.setUint32(16, crc, true);
    header.setUint32(20, body.length, true);
    header.setUint32(24, entry.data.length, true);
    header.setUint16(28, name.length, true);
    header.setUint32(42, offset, true);
    central.push(new Uint8Array(header.buffer), name);
    offset += LOCAL_HEADER + name.length + body.length;
  }
  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = new DataView(new ArrayBuffer(END_RECORD));
  end.setUint32(0, END_SIGNATURE, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  return [...parts, ...central, new Uint8Array(end.buffer)];
}

export function concatParts(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export type ZipFailure =
  | 'package_too_large'
  | 'malformed_container'
  | 'too_many_entries'
  | 'unsupported_entry'
  | 'path_traversal'
  | 'symlink_entry'
  | 'duplicate_entry'
  | 'entry_too_large'
  | 'total_size_exceeded'
  | 'compression_ratio_exceeded'
  | 'entry_size_mismatch'
  | 'crc_mismatch';

export interface ZipDirectoryEntry {
  readonly path: string;
  readonly method: number;
  readonly crc: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly headerStart: number;
  readonly dataStart: number;
}

export type ZipResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ZipFailure };

const fail = (error: ZipFailure): { ok: false; error: ZipFailure } => ({ ok: false, error });

/**
 * Reads and validates the central directory without decompressing anything. Strict: exactly one
 * end record at the end (no comment, no trailing or prepended bytes), central directory directly
 * before it, every local header consistent with its central record, and no overlapping entries.
 */
export function readZipDirectory(
  bytes: Uint8Array,
  limits: PackageLimits = PACKAGE_LIMITS,
): ZipResult<ZipDirectoryEntry[]> {
  if (bytes.length > limits.maxPackageBytes) return fail('package_too_large');
  if (bytes.length < END_RECORD) return fail('malformed_container');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const endOffset = bytes.length - END_RECORD;
  if (view.getUint32(endOffset, true) !== END_SIGNATURE) return fail('malformed_container');
  const diskNumber = view.getUint16(endOffset + 4, true);
  const centralDisk = view.getUint16(endOffset + 6, true);
  const diskEntries = view.getUint16(endOffset + 8, true);
  const totalEntries = view.getUint16(endOffset + 10, true);
  const centralSize = view.getUint32(endOffset + 12, true);
  const centralOffset = view.getUint32(endOffset + 16, true);
  const commentLength = view.getUint16(endOffset + 20, true);
  if (
    diskNumber !== 0 ||
    centralDisk !== 0 ||
    diskEntries !== totalEntries ||
    commentLength !== 0
  ) {
    return fail('malformed_container');
  }
  if (totalEntries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    return fail('malformed_container');
  }
  if (totalEntries > limits.maxEntries) return fail('too_many_entries');
  if (centralOffset + centralSize !== endOffset) return fail('malformed_container');

  const entries: ZipDirectoryEntry[] = [];
  const spans: { start: number; end: number; descriptor: boolean }[] = [];
  const seen = new Set<string>();
  let cursor = centralOffset;
  let totalUncompressed = 0;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (let index = 0; index < totalEntries; index += 1) {
    if (cursor + CENTRAL_HEADER > endOffset) return fail('malformed_container');
    if (view.getUint32(cursor, true) !== CENTRAL_SIGNATURE) return fail('malformed_container');
    const madeBy = view.getUint16(cursor + 4, true);
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const crc = view.getUint32(cursor + 16, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLen = view.getUint16(cursor + 32, true);
    const startDisk = view.getUint16(cursor + 34, true);
    const externalAttributes = view.getUint32(cursor + 38, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const recordEnd = cursor + CENTRAL_HEADER + nameLength + extraLength + commentLen;
    if (recordEnd > endOffset || startDisk !== 0) return fail('malformed_container');
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
      return fail('malformed_container');
    }
    if ((flags & ENCRYPTED_FLAG) !== 0) return fail('unsupported_entry');
    if (method !== METHOD_STORED && method !== METHOD_DEFLATE) return fail('unsupported_entry');
    const nameBytes = bytes.subarray(cursor + CENTRAL_HEADER, cursor + CENTRAL_HEADER + nameLength);
    if ((flags & UTF8_FLAG) === 0 && nameBytes.some((byte) => byte > 0x7f)) {
      return fail('unsupported_entry');
    }
    let path: string;
    try {
      path = decoder.decode(nameBytes);
    } catch {
      return fail('unsupported_entry');
    }
    const host = madeBy >>> 8;
    const mode = externalAttributes >>> 16;
    if (host === UNIX_HOST && (mode & S_IFMT) !== 0 && (mode & S_IFMT) !== S_IFREG) {
      return fail((mode & S_IFMT) === 0o120000 ? 'symlink_entry' : 'unsupported_entry');
    }
    if ((externalAttributes & DOS_DIRECTORY) !== 0 || path.endsWith('/')) {
      return fail('unsupported_entry');
    }
    if (!isSafeEntryPath(path)) return fail('path_traversal');
    const folded = path.toLowerCase();
    if (seen.has(folded)) return fail('duplicate_entry');
    seen.add(folded);
    if (uncompressedSize > limits.maxEntryBytes) return fail('entry_too_large');
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > limits.maxTotalUncompressedBytes) return fail('total_size_exceeded');
    if (method === METHOD_STORED && compressedSize !== uncompressedSize) {
      return fail('malformed_container');
    }
    if (uncompressedSize > Math.max(compressedSize, 1) * limits.maxCompressionRatio) {
      return fail('compression_ratio_exceeded');
    }

    if (localOffset + LOCAL_HEADER > centralOffset) return fail('malformed_container');
    if (view.getUint32(localOffset, true) !== LOCAL_SIGNATURE) return fail('malformed_container');
    const localFlags = view.getUint16(localOffset + 6, true);
    const localMethod = view.getUint16(localOffset + 8, true);
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    if (localMethod !== method || (localFlags & ENCRYPTED_FLAG) !== 0) {
      return fail('malformed_container');
    }
    const localName = bytes.subarray(
      localOffset + LOCAL_HEADER,
      localOffset + LOCAL_HEADER + localNameLength,
    );
    if (!sameBytes(localName, nameBytes)) return fail('malformed_container');
    if ((localFlags & DATA_DESCRIPTOR_FLAG) === 0) {
      if (
        view.getUint32(localOffset + 14, true) !== crc ||
        view.getUint32(localOffset + 18, true) !== compressedSize ||
        view.getUint32(localOffset + 22, true) !== uncompressedSize
      ) {
        return fail('malformed_container');
      }
    }
    const dataStart = localOffset + LOCAL_HEADER + localNameLength + localExtraLength;
    if (dataStart + compressedSize > centralOffset) return fail('malformed_container');
    entries.push({
      path,
      method,
      crc,
      compressedSize,
      uncompressedSize,
      headerStart: localOffset,
      dataStart,
    });
    spans.push({
      start: localOffset,
      end: dataStart + compressedSize,
      descriptor: (localFlags & DATA_DESCRIPTOR_FLAG) !== 0,
    });
    cursor = recordEnd;
  }
  if (cursor !== endOffset) return fail('malformed_container');

  // Entries tile the archive from byte 0 to the central directory: no prepended data, no hidden
  // gaps, and no overlap (one compressed stream referenced twice is a known bomb technique). The
  // only slack allowed is a data descriptor (12–16 bytes) after an entry that declares one.
  spans.sort((left, right) => left.start - right.start);
  let previousEnd = 0;
  let slack = 0;
  for (const span of spans) {
    const gap = span.start - previousEnd;
    if (gap < 0 || gap > slack || (slack > 0 && gap !== 0 && gap < 12)) {
      return fail('malformed_container');
    }
    previousEnd = span.end;
    slack = span.descriptor ? 16 : 0;
  }
  const tail = centralOffset - previousEnd;
  if (tail < 0 || tail > slack || (slack > 0 && tail !== 0 && tail < 12)) {
    return fail('malformed_container');
  }
  return { ok: true, value: entries };
}

/**
 * Decompresses one validated entry. Output is bounded by the declared size while it streams; any
 * excess, shortfall, or CRC difference rejects the entry.
 */
export async function extractEntry(
  bytes: Uint8Array,
  entry: ZipDirectoryEntry,
): Promise<ZipResult<Uint8Array>> {
  const raw = bytes.subarray(entry.dataStart, entry.dataStart + entry.compressedSize);
  let data: Uint8Array;
  if (entry.method === METHOD_STORED) {
    data = raw;
  } else {
    const inflated = await inflateRawBounded(raw, entry.uncompressedSize);
    if (!inflated.ok) return inflated;
    data = inflated.value;
  }
  if (data.length !== entry.uncompressedSize) return fail('entry_size_mismatch');
  if (crc32(data) !== entry.crc) return fail('crc_mismatch');
  return { ok: true, value: data };
}

async function inflateRawBounded(raw: Uint8Array, limit: number): Promise<ZipResult<Uint8Array>> {
  const stream = new Blob([raw as Uint8Array<ArrayBuffer>])
    .stream()
    .pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) {
        await reader.cancel().catch(() => undefined);
        return fail('entry_size_mismatch');
      }
      chunks.push(value);
    }
  } catch {
    return fail('malformed_container');
  }
  return { ok: true, value: concatParts(chunks) };
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as Uint8Array<ArrayBuffer>])
    .stream()
    .pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let index = 0; index < data.length; index += 1) {
    crc = (CRC_TABLE[(crc ^ (data[index] as number)) & 0xff] as number) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
