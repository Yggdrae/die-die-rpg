import type { ExportChunk } from '@rpg/contracts';
import { canonicalBytes, parseBoundedJson, sha256Hex } from './canonical.ts';
import {
  type BuiltPackage,
  buildPackage,
  PackageBuildError,
  type PackageChunk,
  type PreservedChunk,
} from './format.ts';
import { isChunkVersion } from './paths.ts';
import type { ExportRegistry } from './registry.ts';
import { scanForbiddenData } from './scanner.ts';
import type { ModulesLock, SystemLock } from './schemas.ts';
import type { ZipCompression } from './zip.ts';

/**
 * Export orchestrator (`_db.md`, Export Consistency; `_techspec.md`, Export Flow). It reads the
 * pinned rules context and every registered contributor in module order, proves the reads observed
 * one authority state, scans every chunk for forbidden data, and only then builds the package. Any
 * failure yields no package at all: there is never a partial file to offer.
 *
 * It knows no content feature: contributors arrive through the registry, pins through
 * `RulesContextSource`, and opaque chunks preserved by an earlier import through
 * `PreservedChunkSource`.
 */

/** Exact pinned rules context of the campaign (`_prd.md` FR-005). Never a newer installed version. */
export interface RulesContextSource {
  pins(
    campaignId: string,
  ): Promise<
    | { readonly system: SystemLock; readonly modules: readonly ModulesLock['modules'][number][] }
    | undefined
  >;
}

/** Opaque unknown chunks stored with the campaign by an earlier import (feature 07 task 06). */
export interface PreservedChunkSource {
  list(campaignId: string): Promise<readonly PreservedChunk[]>;
}

export const NO_PRESERVED_CHUNKS: PreservedChunkSource = { list: async () => [] };

/** Replica or authority cursor and whether every contributor's data at it is complete. */
export type SnapshotCursor =
  | { readonly complete: true; readonly cursor: string }
  | { readonly complete: false; readonly incompleteModules: readonly string[] };

/**
 * How the orchestrator proves one authority state:
 * - `double_read` (online): read everything twice; equal canonical checksums prove no write landed
 *   between the reads of any two contributors (versions only increase, so a mixed state cannot
 *   repeat). Retried up to `maxAttempts` reads.
 * - `cursor` (offline replica, or an authority cursor): the cursor before and after the reads must
 *   be equal and complete.
 */
export type ExportConsistency =
  | { readonly kind: 'double_read' }
  | { readonly kind: 'cursor'; read(campaignId: string): Promise<SnapshotCursor> };

export type ExportFailureCode =
  | 'registry_incomplete'
  | 'campaign_unavailable'
  | 'contributor_failed'
  | 'contributor_mismatch'
  | 'forbidden_content'
  | 'snapshot_unstable'
  | 'incomplete_replica'
  | 'package_invalid';

/** Safe failure: a code, the contributor's module id, and a payload pointer, never content. */
export interface ExportFailure {
  readonly code: ExportFailureCode;
  readonly moduleId?: string;
  readonly pointer?: string;
  readonly incompleteModules?: readonly string[];
}

export type ExportResult =
  | { readonly ok: true; readonly value: BuiltPackage }
  | { readonly ok: false; readonly error: ExportFailure };

export interface ExportOrchestratorOptions {
  readonly registry: ExportRegistry;
  readonly rules: RulesContextSource;
  readonly preserved?: PreservedChunkSource;
  readonly applicationVersion: string;
  readonly consistency?: ExportConsistency;
  /** Consistency comparisons attempted before `snapshot_unstable`. Default 3. */
  readonly maxAttempts?: number;
  readonly compression?: ZipCompression;
  readonly now?: () => Date;
}

interface Snapshot {
  readonly pins: {
    readonly system: SystemLock;
    readonly modules: readonly ModulesLock['modules'][number][];
  };
  readonly chunks: PackageChunk[];
  readonly preserved: readonly PreservedChunk[];
  readonly fingerprint: string;
}

type Read = { ok: true; value: Snapshot } | { ok: false; error: ExportFailure };

export class ExportOrchestrator {
  readonly #options: ExportOrchestratorOptions;

  constructor(options: ExportOrchestratorOptions) {
    this.#options = options;
  }

  async export(
    campaignId: string,
    request: { readonly exportedBy: { readonly displayName: string } },
  ): Promise<ExportResult> {
    const { registry } = this.#options;
    if (!registry.isComplete()) return { ok: false, error: { code: 'registry_incomplete' } };
    const consistency = this.#options.consistency ?? { kind: 'double_read' };
    const attempts = Math.max(1, this.#options.maxAttempts ?? 3);

    let snapshot: Snapshot | undefined;
    if (consistency.kind === 'cursor') {
      for (let attempt = 0; attempt < attempts && snapshot === undefined; attempt += 1) {
        const before = await consistency.read(campaignId);
        if (!before.complete) return incomplete(before.incompleteModules);
        const read = await this.#read(campaignId);
        if (!read.ok) return read;
        const after = await consistency.read(campaignId);
        if (!after.complete) return incomplete(after.incompleteModules);
        if (after.cursor === before.cursor) snapshot = read.value;
      }
    } else {
      let previous: Snapshot | undefined;
      for (let attempt = 0; attempt <= attempts && snapshot === undefined; attempt += 1) {
        const read = await this.#read(campaignId);
        if (!read.ok) return read;
        if (previous !== undefined && previous.fingerprint === read.value.fingerprint) {
          snapshot = read.value;
        }
        previous = read.value;
      }
    }
    if (snapshot === undefined) return { ok: false, error: { code: 'snapshot_unstable' } };

    try {
      const built = await buildPackage({
        applicationVersion: this.#options.applicationVersion,
        exportedAt: (this.#options.now?.() ?? new Date()).toISOString(),
        exportedBy: request.exportedBy,
        campaignId,
        systemLock: snapshot.pins.system,
        modulesLock: { modules: [...snapshot.pins.modules] },
        chunks: snapshot.chunks,
        preserved: snapshot.preserved,
        compression: this.#options.compression,
      });
      return { ok: true, value: built };
    } catch (error) {
      if (error instanceof PackageBuildError) {
        return {
          ok: false,
          error: {
            code: 'package_invalid',
            ...(error.moduleId === undefined ? {} : { moduleId: error.moduleId }),
          },
        };
      }
      throw error;
    }
  }

  async #read(campaignId: string): Promise<Read> {
    const pins = await this.#options.rules.pins(campaignId);
    if (pins === undefined) return { ok: false, error: { code: 'campaign_unavailable' } };
    const chunks: PackageChunk[] = [];
    const digests: string[] = [await sha256Hex(canonicalBytes(pins))];
    for (const registration of this.#options.registry.list()) {
      const moduleId = registration.module.moduleId;
      let chunk: ExportChunk;
      try {
        chunk = await registration.module.export(campaignId);
      } catch {
        return { ok: false, error: { code: 'contributor_failed', moduleId } };
      }
      if (
        chunk === null ||
        typeof chunk !== 'object' ||
        chunk.moduleId !== moduleId ||
        typeof chunk.chunkVersion !== 'string' ||
        !isChunkVersion(chunk.chunkVersion)
      ) {
        return { ok: false, error: { code: 'contributor_mismatch', moduleId } };
      }
      let bytes: Uint8Array;
      try {
        bytes = canonicalBytes(chunk.payload);
      } catch {
        return { ok: false, error: { code: 'contributor_failed', moduleId } };
      }
      // The package must pass its own inspector: payloads stay within the JSON bounds.
      if (!parseBoundedJson(bytes).ok) {
        return { ok: false, error: { code: 'contributor_failed', moduleId } };
      }
      const finding = scanForbiddenData(chunk.payload);
      if (finding !== undefined) {
        return {
          ok: false,
          error: { code: 'forbidden_content', moduleId, pointer: finding.pointer },
        };
      }
      let records: number | undefined;
      if (registration.countRecords !== undefined) {
        const counted = registration.countRecords(chunk.payload);
        records = Number.isInteger(counted) && counted >= 0 ? counted : undefined;
      }
      chunks.push({
        placement: registration.placement,
        moduleId,
        chunkVersion: chunk.chunkVersion,
        payload: chunk.payload,
        ...(records === undefined ? {} : { records }),
      });
      digests.push(`${moduleId}:${chunk.chunkVersion}:${await sha256Hex(bytes)}`);
    }
    const preserved = await (this.#options.preserved ?? NO_PRESERVED_CHUNKS).list(campaignId);
    for (const chunk of preserved) {
      digests.push(
        `preserved:${chunk.moduleId}:${chunk.chunkVersion}:${await sha256Hex(canonicalBytes(chunk.payload))}`,
      );
    }
    return {
      ok: true,
      value: { pins, chunks, preserved, fingerprint: digests.join('\n') },
    };
  }
}

function incomplete(modules: readonly string[]): ExportResult {
  return { ok: false, error: { code: 'incomplete_replica', incompleteModules: [...modules] } };
}
