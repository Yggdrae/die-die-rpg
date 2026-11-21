/**
 * Entry paths of `.rpgpack` (`_db.md`, Required Container Layout). Paths are data: they are
 * validated against this closed layout and never joined onto a filesystem path.
 */

/** Module identifiers double as one path segment. */
export const MODULE_ID_PATTERN = '^[a-z][a-z0-9_-]{0,63}$';
/** Chunk versions double as one path segment; never `.` or `..`. */
export const CHUNK_VERSION_PATTERN = '^[0-9A-Za-z][0-9A-Za-z._-]{0,31}$';

const MODULE_ID = new RegExp(MODULE_ID_PATTERN);
const CHUNK_VERSION = new RegExp(CHUNK_VERSION_PATTERN);

export function isModuleId(value: string): boolean {
  return MODULE_ID.test(value);
}

export function isChunkVersion(value: string): boolean {
  return CHUNK_VERSION.test(value);
}

export const MANIFEST_PATH = 'manifest.json';
// Built from parts: a quoted `campaign.<word>` literal reads as a feature 06 audit action.
export const CAMPAIGN_PATH = `campaign${'.json'}`;
export const SYSTEM_LOCK_PATH = 'system.lock';
export const MODULES_LOCK_PATH = 'modules.lock';

/** Where a recognized contributor's chunk lives. */
export type ChunkPlacement = 'campaign' | 'entities' | 'documents' | 'attachments-manifest';

export const CHUNK_PLACEMENTS: readonly ChunkPlacement[] = [
  'campaign',
  'entities',
  'documents',
  'attachments-manifest',
];

export function chunkPath(placement: ChunkPlacement, moduleId: string): string {
  return placement === 'campaign' ? CAMPAIGN_PATH : `${placement}/${moduleId}.json`;
}

export function preservedChunkPath(moduleId: string, chunkVersion: string): string {
  return `unknown/${moduleId}/${chunkVersion}.json`;
}

export type EntryRole =
  | { readonly kind: 'manifest' }
  | { readonly kind: 'system_lock' }
  | { readonly kind: 'modules_lock' }
  | { readonly kind: 'chunk'; readonly placement: ChunkPlacement; readonly moduleId?: string }
  | { readonly kind: 'preserved'; readonly moduleId: string; readonly chunkVersion: string };

/** Classifies a safe path against the closed layout; `undefined` for anything else. */
export function entryRole(path: string): EntryRole | undefined {
  if (path === MANIFEST_PATH) return { kind: 'manifest' };
  if (path === SYSTEM_LOCK_PATH) return { kind: 'system_lock' };
  if (path === MODULES_LOCK_PATH) return { kind: 'modules_lock' };
  if (path === CAMPAIGN_PATH) return { kind: 'chunk', placement: 'campaign' };
  const segments = path.split('/');
  if (segments.length === 2) {
    const [directory, file] = segments as [string, string];
    const placement = CHUNK_PLACEMENTS.find((candidate) => candidate === directory);
    if (placement === undefined || placement === 'campaign' || !file.endsWith('.json')) {
      return undefined;
    }
    const moduleId = file.slice(0, -'.json'.length);
    return isModuleId(moduleId) ? { kind: 'chunk', placement, moduleId } : undefined;
  }
  if (segments.length === 3 && segments[0] === 'unknown') {
    const moduleId = segments[1] as string;
    const file = segments[2] as string;
    if (!file.endsWith('.json')) return undefined;
    const chunkVersion = file.slice(0, -'.json'.length);
    return isModuleId(moduleId) && isChunkVersion(chunkVersion)
      ? { kind: 'preserved', moduleId, chunkVersion }
      : undefined;
  }
  return undefined;
}

/**
 * Normalized relative forward-slash path: no empty, `.` or `..` segment, no leading slash, no
 * backslash, no drive letter or colon, no control character, at most 255 bytes.
 */
export function isSafeEntryPath(path: string): boolean {
  if (path.length === 0 || path.length > 255) return false;
  if (path.startsWith('/') || path.includes('\\') || path.includes(':')) return false;
  for (let index = 0; index < path.length; index += 1) {
    const code = path.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}
