/**
 * Feature 05 MVP file policy (`_prd.md` FR-006, `_db.md`). Pure and browser-safe: the web client
 * uses it as a convenience check, the server enforces it independently before any grant exists.
 */

export const ATTACHMENT_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;
export type AttachmentMimeType = (typeof ATTACHMENT_MIME_TYPES)[number];

/** 25 MB (25 × 1024 × 1024 bytes), inclusive. */
export const MAX_ATTACHMENT_BYTES = 26_214_400;
export const MAX_FILENAME_CODE_POINTS = 255;

/** Signed upload URL lifetime (`_db.md`, Object Layout and Credentials). */
export const UPLOAD_GRANT_SECONDS = 600;
/** Signed read URL lifetime. A leaked URL ages out after this. */
export const READ_GRANT_SECONDS = 300;
/** Unfinalized uploads expire after this (database time, exclusive). */
export const PENDING_LIFETIME_HOURS = 24;
/** Pending and failed metadata is hard-deleted after this; it was never synchronized. */
export const ABANDONED_METADATA_DAYS = 7;
/** A deleted ready attachment keeps its bytes this long (`purge_after`, fixed at deletion). */
export const DELETED_RETENTION_DAYS = 30;

export type FilePolicyViolation =
  | 'unsupported_file_type'
  | 'file_too_large'
  | 'empty_file'
  | 'invalid_filename'
  | 'invalid_checksum';

export interface DeclaredFile {
  readonly filename: string;
  readonly mime: string;
  readonly size: number;
  /** Lowercase hex SHA-256 of the whole file. */
  readonly checksum: string;
}

export function isAllowedMime(mime: string): mime is AttachmentMimeType {
  return (ATTACHMENT_MIME_TYPES as readonly string[]).includes(mime);
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

export function isSha256Hex(value: string): boolean {
  return SHA256_HEX.test(value);
}

/** C0 and C1 controls, DEL, and both path separators (same set as the database check). */
function isUnsafeCodePoint(codePoint: number): boolean {
  return (
    codePoint <= 0x1f ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    codePoint === 0x2f ||
    codePoint === 0x5c
  );
}

/** 1–255 code points, no control character or path separator, not a dot segment or blank. */
export function isSafeFilename(filename: string): boolean {
  if (typeof filename !== 'string') return false;
  const codePoints = [...filename].map((character) => character.codePointAt(0) ?? 0);
  return (
    codePoints.length >= 1 &&
    codePoints.length <= MAX_FILENAME_CODE_POINTS &&
    filename.trim() !== '' &&
    filename !== '.' &&
    filename !== '..' &&
    !codePoints.some(isUnsafeCodePoint)
  );
}

/**
 * First violated rule, or `undefined`. Type before size, so an oversized unsupported file reports
 * the type. Nothing here trusts a client's own verdict.
 */
export function checkFilePolicy(file: DeclaredFile): FilePolicyViolation | undefined {
  if (!isAllowedMime(file.mime)) return 'unsupported_file_type';
  if (!Number.isSafeInteger(file.size) || file.size < 1) return 'empty_file';
  if (file.size > MAX_ATTACHMENT_BYTES) return 'file_too_large';
  if (!isSafeFilename(file.filename)) return 'invalid_filename';
  if (!isSha256Hex(file.checksum)) return 'invalid_checksum';
  return undefined;
}

/** Images render inert in `<img>`; documents open only outside the application origin. */
export function renderKindFor(mime: AttachmentMimeType): 'image' | 'document' {
  return mime === 'application/pdf' ? 'document' : 'image';
}
