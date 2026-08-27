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
 */
export interface SyncedRepository<T> {
  get(id: Id): Promise<Result<T, RepositoryError>>;

  list(campaignId: Id, options?: ListOptions): Promise<Result<T[], RepositoryError>>;

  upsert(value: T, expectedVersion: Version | null): Promise<Result<T, RepositoryError>>;

  softDelete(id: Id, expectedVersion: Version): Promise<Result<void, RepositoryError>>;
}
