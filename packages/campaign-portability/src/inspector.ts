import { check } from '@rpg/contracts';
import { parseBoundedJson, sha256Hex } from './canonical.ts';
import { JSON_LIMITS, type JsonLimits, PACKAGE_LIMITS, type PackageLimits } from './limits.ts';
import {
  CAMPAIGN_PATH,
  type ChunkPlacement,
  type EntryRole,
  entryRole,
  MANIFEST_PATH,
  MODULES_LOCK_PATH,
  SYSTEM_LOCK_PATH,
} from './paths.ts';
import {
  ChunkFile,
  type ContributorRecord,
  Manifest,
  ModulesLock,
  RPGPACK_FORMAT_VERSION,
  SystemLock,
} from './schemas.ts';
import { extractEntry, readZipDirectory, type ZipDirectoryEntry, type ZipFailure } from './zip.ts';

/**
 * Package inspector (`_db.md`, Atomic Import steps 1–2). A pure function of the bytes: it has no
 * write dependency, never touches a filesystem, and returns either a fully validated package or
 * one safe failure code. Recognized chunk payloads are validated later by their contributor;
 * here every payload is only bounded JSON inside a well-formed chunk envelope.
 */

export type InspectionCode =
  | ZipFailure
  | 'missing_required_member'
  | 'manifest_invalid'
  | 'unsupported_format_version'
  | 'undeclared_entry'
  | 'checksum_mismatch'
  | 'duplicate_module'
  | 'malformed_json'
  | 'json_limits_exceeded'
  | 'chunk_invalid'
  | 'lock_invalid';

/** `path` and `moduleId` are present only when they passed validation (never raw input). */
export interface InspectionFailure {
  readonly code: InspectionCode;
  readonly path?: string;
  readonly moduleId?: string;
}

export interface InspectedChunk {
  readonly moduleId: string;
  readonly chunkVersion: string;
  readonly placement: ChunkPlacement;
  readonly path: string;
  readonly checksum: string;
  readonly payload: unknown;
}

export interface InspectedPreservedChunk {
  readonly moduleId: string;
  readonly chunkVersion: string;
  readonly path: string;
  readonly checksum: string;
  readonly payload: unknown;
}

export interface InspectedPackage {
  readonly manifest: Manifest;
  readonly manifestChecksum: string;
  readonly systemLock: SystemLock;
  readonly modulesLock: ModulesLock;
  /** Sorted by module id. */
  readonly chunks: readonly InspectedChunk[];
  readonly preserved: readonly InspectedPreservedChunk[];
}

export type InspectionResult =
  | { readonly ok: true; readonly value: InspectedPackage }
  | { readonly ok: false; readonly error: InspectionFailure };

export interface InspectionOptions {
  readonly limits?: PackageLimits;
  readonly json?: JsonLimits;
}

const failure = (
  code: InspectionCode,
  where: { path?: string; moduleId?: string } = {},
): InspectionResult => ({ ok: false, error: { code, ...where } });

export async function inspectPackage(
  bytes: Uint8Array,
  options: InspectionOptions = {},
): Promise<InspectionResult> {
  const json = options.json ?? JSON_LIMITS;
  const directory = readZipDirectory(bytes, options.limits ?? PACKAGE_LIMITS);
  if (!directory.ok) return failure(directory.error);

  const roles = new Map<string, { entry: ZipDirectoryEntry; role: EntryRole }>();
  for (const entry of directory.value) {
    const role = entryRole(entry.path);
    if (role === undefined) return failure('unsupported_entry');
    roles.set(entry.path, { entry, role });
  }
  for (const required of [MANIFEST_PATH, CAMPAIGN_PATH, SYSTEM_LOCK_PATH, MODULES_LOCK_PATH]) {
    if (!roles.has(required)) return failure('missing_required_member', { path: required });
  }
  if (
    ![...roles.values()].some(
      ({ role }) => role.kind === 'chunk' && role.placement === 'attachments-manifest',
    )
  ) {
    return failure('missing_required_member', { path: 'attachments-manifest/' });
  }

  const manifestEntry = roles.get(MANIFEST_PATH)?.entry as ZipDirectoryEntry;
  const manifestBytes = await extractEntry(bytes, manifestEntry);
  if (!manifestBytes.ok) return failure(manifestBytes.error, { path: MANIFEST_PATH });
  const manifestJson = parseBoundedJson(manifestBytes.value, json);
  if (!manifestJson.ok) return failure(manifestJson.error, { path: MANIFEST_PATH });
  const manifestValue = manifestJson.value;
  if (
    typeof manifestValue === 'object' &&
    manifestValue !== null &&
    (manifestValue as { format?: unknown }).format === 'rpgpack' &&
    Number.isInteger((manifestValue as { formatVersion?: unknown }).formatVersion) &&
    (manifestValue as { formatVersion: number }).formatVersion !== RPGPACK_FORMAT_VERSION
  ) {
    return failure('unsupported_format_version', { path: MANIFEST_PATH });
  }
  if (!check(Manifest, manifestValue)) return failure('manifest_invalid', { path: MANIFEST_PATH });
  const manifest = manifestValue;

  // The manifest lists exactly the other entries, each once.
  const declared = new Map<string, { sha256: string; size: number }>();
  for (const entry of manifest.entries) {
    if (declared.has(entry.path) || entry.path === MANIFEST_PATH || !roles.has(entry.path)) {
      return failure('manifest_invalid', { path: MANIFEST_PATH });
    }
    declared.set(entry.path, entry);
  }
  for (const path of roles.keys()) {
    if (path !== MANIFEST_PATH && !declared.has(path)) return failure('undeclared_entry', { path });
  }

  const contributorFor = new Map<string, ContributorRecord>();
  const recognizedModules = new Set<string>();
  for (const record of manifest.contributors) {
    const role = roles.get(record.path)?.role;
    if (
      role === undefined ||
      role.kind !== 'chunk' ||
      (role.moduleId !== undefined && role.moduleId !== record.moduleId)
    ) {
      return failure('manifest_invalid', { path: MANIFEST_PATH });
    }
    if (recognizedModules.has(record.moduleId) || contributorFor.has(record.path)) {
      return failure('duplicate_module', { moduleId: record.moduleId });
    }
    recognizedModules.add(record.moduleId);
    contributorFor.set(record.path, record);
  }
  for (const record of manifest.preserved) {
    const role = roles.get(record.path)?.role;
    if (
      role === undefined ||
      role.kind !== 'preserved' ||
      role.moduleId !== record.moduleId ||
      role.chunkVersion !== record.chunkVersion
    ) {
      return failure('manifest_invalid', { path: MANIFEST_PATH });
    }
    if (contributorFor.has(record.path)) {
      return failure('duplicate_module', { moduleId: record.moduleId });
    }
    contributorFor.set(record.path, record);
  }
  for (const [path, { role }] of roles) {
    if ((role.kind === 'chunk' || role.kind === 'preserved') && !contributorFor.has(path)) {
      return failure('undeclared_entry', { path });
    }
  }

  const chunks: InspectedChunk[] = [];
  const preserved: InspectedPreservedChunk[] = [];
  let systemLock: SystemLock | undefined;
  let modulesLock: ModulesLock | undefined;
  for (const [path, { entry, role }] of [...roles].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (role.kind === 'manifest') continue;
    const extracted = await extractEntry(bytes, entry);
    if (!extracted.ok) return failure(extracted.error, { path });
    const expected = declared.get(path) as { sha256: string; size: number };
    const checksum = await sha256Hex(extracted.value);
    if (checksum !== expected.sha256 || extracted.value.length !== expected.size) {
      return failure('checksum_mismatch', { path });
    }
    const parsed = parseBoundedJson(extracted.value, json);
    if (!parsed.ok) return failure(parsed.error, { path });
    if (role.kind === 'system_lock') {
      if (!check(SystemLock, parsed.value)) return failure('lock_invalid', { path });
      systemLock = parsed.value;
      continue;
    }
    if (role.kind === 'modules_lock') {
      if (!check(ModulesLock, parsed.value)) return failure('lock_invalid', { path });
      const ids = parsed.value.modules.map((pin) => pin.moduleId);
      if (new Set(ids).size !== ids.length) return failure('lock_invalid', { path });
      modulesLock = parsed.value;
      continue;
    }
    const record = contributorFor.get(path) as ContributorRecord;
    if (record.checksum !== checksum) return failure('checksum_mismatch', { path });
    if (
      !check(ChunkFile, parsed.value) ||
      parsed.value.moduleId !== record.moduleId ||
      parsed.value.chunkVersion !== record.chunkVersion
    ) {
      return failure('chunk_invalid', { path, moduleId: record.moduleId });
    }
    if (role.kind === 'preserved') {
      preserved.push({ ...record, payload: parsed.value.payload });
    } else {
      chunks.push({ ...record, placement: role.placement, payload: parsed.value.payload });
    }
  }
  if (systemLock === undefined || modulesLock === undefined) {
    return failure('missing_required_member');
  }
  return {
    ok: true,
    value: {
      manifest,
      manifestChecksum: await sha256Hex(manifestBytes.value),
      systemLock,
      modulesLock,
      chunks: chunks.sort((a, b) => (a.moduleId < b.moduleId ? -1 : 1)),
      preserved,
    },
  };
}
