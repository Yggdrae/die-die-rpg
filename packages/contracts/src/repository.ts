import type { ApiError } from './error.ts';
import type { Id, Version } from './primitives.ts';
import type { Result } from './result.ts';

/**
 * A stale write. Carries both versions so feature 03 can render an explicit choice rather
 * than picking a winner (`PRD.md` s.57, s.80).
 */
export interface VersionConflict {
  readonly kind: 'version_conflict';
  readonly id: Id;
  readonly expectedVersion: Version;
  readonly actualVersion: Version;
}

export interface NotFound {
  readonly kind: 'not_found';
  readonly id: Id;
}

export type RepositoryError = VersionConflict | NotFound | ApiError;

export function isVersionConflict(error: RepositoryError): error is VersionConflict {
  return 'kind' in error && error.kind === 'version_conflict';
}

/**
 * A conflict discovered after the fact.
 *
 * Established by the wave 0 spike (`.speckit/features/00-platform-foundation/spike-findings.md`,
 * Finding 1): the sync provider is asymmetric. Reads flow server to client, but a write made
 * offline succeeds locally, is queued, and is only checked against the server version on upload.
 * By then the interface has already told the user the change was applied.
 *
 * So `upsert` cannot be the only way a feature learns about a conflict. It reports the
 * synchronous case; this reports the deferred one. `PRD.md` s.80 requires both to reach the
 * user explicitly rather than resolving by overwrite.
 */
export interface DeferredConflict {
  readonly kind: 'deferred_version_conflict';
  readonly table: string;
  readonly id: Id;
  readonly expectedVersion: Version;
  readonly actualVersion: Version;
  readonly detectedAt: string;
}

/**
 * Where deferred conflicts surface.
 *
 * Feature 03 implements it and owns the shared conflict presentation (its FR-009). Features
 * observe it; they do not each invent a way to notice that a write they reported as successful
 * was later rejected.
 */
export interface ConflictChannel {
  /** Returns an unsubscribe function. */
  subscribe(listener: (conflict: DeferredConflict) => void): () => void;
}

export interface ListOptions {
  /** Tombstoned records are excluded unless asked for. */
  readonly includeDeleted?: boolean;
  readonly limit?: number;
  readonly offset?: number;
}

/**
 * The persistence contract every feature uses and no feature implements.
 *
 * Provider-neutral on purpose (`PRD.md` s.55): feature 03 implements it over local SQLite
 * plus PowerSync, and `@rpg/contracts/testing` ships an in-memory double so waves 1 and 2
 * can build before feature 03 exists.
 *
 * `expectedVersion` is required, not optional. That is the point: an optional version is
 * an optional conflict check, and an optional conflict check becomes last-write-wins
 * across twenty features under deadline pressure.
 *
 * A successful `upsert` is NOT proof the write was accepted by the server. While offline it
 * means the write was accepted locally and queued. Watch `conflicts` for the rest of the
 * story — see `DeferredConflict`.
 */
export interface SyncedRepository<T> {
  /** Deferred conflicts for records this repository owns. */
  readonly conflicts: ConflictChannel;

  get(id: Id): Promise<Result<T, RepositoryError>>;

  list(campaignId: Id, options?: ListOptions): Promise<Result<T[], RepositoryError>>;

  upsert(value: T, expectedVersion: Version | null): Promise<Result<T, RepositoryError>>;

  softDelete(id: Id, expectedVersion: Version): Promise<Result<void, RepositoryError>>;
}
