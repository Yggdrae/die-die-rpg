import { check, Id } from '@rpg/contracts';
import { canonicalBytes, sha256Hex } from './canonical.ts';
import {
  type ChunkPlacement,
  chunkPath,
  isChunkVersion,
  isModuleId,
  MANIFEST_PATH,
  MODULES_LOCK_PATH,
  preservedChunkPath,
  SYSTEM_LOCK_PATH,
} from './paths.ts';
import {
  type ContributorRecord,
  type ContributorSummary,
  type Manifest,
  type ManifestEntry,
  ModulesLock,
  RPGPACK_FORMAT_VERSION,
  SystemLock,
} from './schemas.ts';
import { writeZip, type ZipCompression } from './zip.ts';

/**
 * Deterministic `.rpgpack` writer (`_db.md`). Every entry is canonical JSON, entries are sorted by
 * path, and the manifest records a SHA-256 for each, so equal logical content yields equal entry
 * checksums wherever it is generated. With `store` (the default) the archive bytes are identical
 * too.
 */

export interface PackageChunk {
  readonly placement: ChunkPlacement;
  readonly moduleId: string;
  readonly chunkVersion: string;
  readonly payload: unknown;
  /** Logical record count for the safe summary, when the registration can tell. */
  readonly records?: number;
}

export interface PreservedChunk {
  readonly moduleId: string;
  readonly chunkVersion: string;
  readonly payload: unknown;
}

export interface PackageInput {
  readonly applicationVersion: string;
  readonly exportedAt: string;
  readonly exportedBy: { readonly displayName: string };
  readonly campaignId: string;
  readonly systemLock: SystemLock;
  readonly modulesLock: ModulesLock;
  readonly chunks: readonly PackageChunk[];
  readonly preserved?: readonly PreservedChunk[];
  readonly compression?: ZipCompression;
}

export interface BuiltPackage {
  /** Archive parts in order; stream them, or concatenate for a single download. */
  readonly parts: Uint8Array[];
  readonly size: number;
  readonly manifest: Manifest;
  readonly manifestChecksum: string;
  readonly summary: ContributorSummary[];
}

export type PackageBuildFailure =
  | 'invalid_module_id'
  | 'invalid_chunk_version'
  | 'duplicate_module'
  | 'missing_campaign_chunk'
  | 'missing_attachment_manifest'
  | 'invalid_lock'
  | 'invalid_metadata'
  | 'unserializable_payload';

export class PackageBuildError extends Error {
  constructor(
    readonly code: PackageBuildFailure,
    readonly moduleId?: string,
  ) {
    super(`rpgpack_build: ${code}${moduleId === undefined ? '' : ` (${moduleId})`}`);
    this.name = 'PackageBuildError';
  }
}

export async function buildPackage(input: PackageInput): Promise<BuiltPackage> {
  if (!check(SystemLock, input.systemLock) || !check(ModulesLock, input.modulesLock)) {
    throw new PackageBuildError('invalid_lock');
  }
  if (
    !check(Id, input.campaignId) ||
    input.exportedBy.displayName.length === 0 ||
    input.exportedBy.displayName.length > 64 ||
    input.applicationVersion.length === 0 ||
    input.applicationVersion.length > 64
  ) {
    throw new PackageBuildError('invalid_metadata');
  }
  const seen = new Set<string>();
  for (const chunk of input.chunks) {
    if (!isModuleId(chunk.moduleId)) throw new PackageBuildError('invalid_module_id');
    if (!isChunkVersion(chunk.chunkVersion)) {
      throw new PackageBuildError('invalid_chunk_version', chunk.moduleId);
    }
    if (seen.has(chunk.moduleId)) throw new PackageBuildError('duplicate_module', chunk.moduleId);
    seen.add(chunk.moduleId);
  }
  if (input.chunks.filter((chunk) => chunk.placement === 'campaign').length !== 1) {
    throw new PackageBuildError('missing_campaign_chunk');
  }
  if (!input.chunks.some((chunk) => chunk.placement === 'attachments-manifest')) {
    throw new PackageBuildError('missing_attachment_manifest');
  }
  const preservedKeys = new Set<string>();
  for (const chunk of input.preserved ?? []) {
    if (!isModuleId(chunk.moduleId)) throw new PackageBuildError('invalid_module_id');
    if (!isChunkVersion(chunk.chunkVersion)) {
      throw new PackageBuildError('invalid_chunk_version', chunk.moduleId);
    }
    const key = `${chunk.moduleId}/${chunk.chunkVersion}`;
    if (preservedKeys.has(key)) throw new PackageBuildError('duplicate_module', chunk.moduleId);
    preservedKeys.add(key);
  }

  const files = new Map<string, Uint8Array>();
  const contributors: ContributorRecord[] = [];
  const preserved: ContributorRecord[] = [];
  const summary: ContributorSummary[] = [];
  const serialize = (moduleId: string, value: unknown) => {
    try {
      return canonicalBytes(value);
    } catch {
      throw new PackageBuildError('unserializable_payload', moduleId);
    }
  };

  for (const chunk of sortBy(input.chunks, (chunk) => chunk.moduleId)) {
    const path = chunkPath(chunk.placement, chunk.moduleId);
    const bytes = serialize(chunk.moduleId, {
      moduleId: chunk.moduleId,
      chunkVersion: chunk.chunkVersion,
      payload: chunk.payload,
    });
    files.set(path, bytes);
    const checksum = await sha256Hex(bytes);
    contributors.push({
      moduleId: chunk.moduleId,
      chunkVersion: chunk.chunkVersion,
      path,
      checksum,
    });
    summary.push({
      moduleId: chunk.moduleId,
      chunkVersion: chunk.chunkVersion,
      ...(chunk.records === undefined ? {} : { records: chunk.records }),
      bytes: bytes.length,
    });
  }
  for (const chunk of sortBy(
    input.preserved ?? [],
    (chunk) => `${chunk.moduleId}/${chunk.chunkVersion}`,
  )) {
    const path = preservedChunkPath(chunk.moduleId, chunk.chunkVersion);
    const bytes = serialize(chunk.moduleId, {
      moduleId: chunk.moduleId,
      chunkVersion: chunk.chunkVersion,
      payload: chunk.payload,
    });
    files.set(path, bytes);
    const checksum = await sha256Hex(bytes);
    preserved.push({ moduleId: chunk.moduleId, chunkVersion: chunk.chunkVersion, path, checksum });
    summary.push({
      moduleId: chunk.moduleId,
      chunkVersion: chunk.chunkVersion,
      bytes: bytes.length,
      preserved: true,
    });
  }
  files.set(SYSTEM_LOCK_PATH, canonicalBytes(input.systemLock));
  files.set(MODULES_LOCK_PATH, canonicalBytes(sortedModulesLock(input.modulesLock)));

  const entries: ManifestEntry[] = [];
  for (const path of [...files.keys()].sort()) {
    const bytes = files.get(path) as Uint8Array;
    entries.push({ path, sha256: await sha256Hex(bytes), size: bytes.length });
  }
  const manifest: Manifest = {
    format: 'rpgpack',
    formatVersion: RPGPACK_FORMAT_VERSION,
    applicationVersion: input.applicationVersion,
    exportedAt: input.exportedAt,
    exportedBy: { displayName: input.exportedBy.displayName },
    source: { campaignId: input.campaignId },
    content: { attachmentBinaries: 'excluded', audit: 'excluded' },
    entries,
    contributors,
    preserved,
  };
  const manifestBytes = canonicalBytes(manifest);
  const parts = await writeZip(
    [
      { path: MANIFEST_PATH, data: manifestBytes },
      ...entries.map((entry) => ({ path: entry.path, data: files.get(entry.path) as Uint8Array })),
    ],
    { compression: input.compression ?? 'store' },
  );
  return {
    parts,
    size: parts.reduce((sum, part) => sum + part.length, 0),
    manifest,
    manifestChecksum: await sha256Hex(manifestBytes),
    summary,
  };
}

function sortedModulesLock(lock: ModulesLock): ModulesLock {
  return { modules: sortBy(lock.modules, (pin) => pin.moduleId) };
}

function sortBy<T>(items: readonly T[], key: (item: T) => string): T[] {
  return [...items].sort((left, right) => {
    const a = key(left);
    const b = key(right);
    return a < b ? -1 : a > b ? 1 : 0;
  });
}
