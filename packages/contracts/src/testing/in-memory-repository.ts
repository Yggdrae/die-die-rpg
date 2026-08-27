import type { EntityEnvelope } from '../entity.ts';
import type { Id, Version } from '../primitives.ts';
import type {
  ConflictChannel,
  DeferredConflict,
  ListOptions,
  RepositoryError,
  SyncedRepository,
} from '../repository.ts';
import { err, ok, type Result } from '../result.ts';

/**
 * Development and test double for `SyncedRepository`.
 *
 * NOT a product path. No persistence across process restart, no sync, no queue, no
 * network. Feature 03 owns the real implementation over local SQLite plus PowerSync
 * (`PRD.md` s.52 to s.55); this exists only so features in waves 1 and 2 can be built and
 * demonstrated before feature 03 lands.
 *
 * Consuming features swap one import when feature 03 ships. If this double ever grows a
 * queue, a reconnect, or a persistence layer, it has become feature 03 and belongs there.
 *
 * The conflict path carries the test weight deliberately: if the double is more permissive
 * than the real implementation, waves 1 and 2 build against behavior that does not exist.
 */
export class InMemoryRepository<T extends EntityEnvelope> implements SyncedRepository<T> {
  readonly #records = new Map<Id, T>();
  readonly #conflictListeners = new Set<(conflict: DeferredConflict) => void>();

  /**
   * This double is synchronous, so it never produces a deferred conflict on its own. The
   * channel exists so features can be built and tested against the real shape, and
   * `emitDeferredConflict` lets a test drive the path feature 03 will drive in production.
   */
  readonly conflicts: ConflictChannel = {
    subscribe: (listener) => {
      this.#conflictListeners.add(listener);
      return () => this.#conflictListeners.delete(listener);
    },
  };

  /** Test-only: simulate a conflict discovered on upload after an offline write. */
  emitDeferredConflict(conflict: DeferredConflict): void {
    for (const listener of this.#conflictListeners) {
      listener(conflict);
    }
  }

  /** Seed fixture data without going through version checks. */
  seed(records: readonly T[]): void {
    for (const record of records) {
      this.#records.set(record.id, structuredClone(record) as T);
    }
  }

  get size(): number {
    return this.#records.size;
  }

  async get(id: Id): Promise<Result<T, RepositoryError>> {
    const found = this.#records.get(id);
    if (found === undefined) {
      return err({ kind: 'not_found', id });
    }
    return ok(structuredClone(found) as T);
  }

  async list(campaignId: Id, options?: ListOptions): Promise<Result<T[], RepositoryError>> {
    const includeDeleted = options?.includeDeleted ?? false;
    const offset = options?.offset ?? 0;

    let matches = [...this.#records.values()].filter((record) => record.campaignId === campaignId);
    if (!includeDeleted) {
      matches = matches.filter((record) => record.deletedAt === undefined);
    }
    matches.sort((a, b) => a.id.localeCompare(b.id));

    const limited =
      options?.limit === undefined
        ? matches.slice(offset)
        : matches.slice(offset, offset + options.limit);

    return ok(limited.map((record) => structuredClone(record) as T));
  }

  /**
   * `expectedVersion` is `null` for a create and the current version for an update.
   * A mismatch conflicts and leaves stored state untouched.
   */
  async upsert(value: T, expectedVersion: Version | null): Promise<Result<T, RepositoryError>> {
    const current = this.#records.get(value.id);

    if (current === undefined) {
      if (expectedVersion !== null) {
        return err({ kind: 'not_found', id: value.id });
      }
      const created = { ...structuredClone(value), version: 1 } as T;
      this.#records.set(created.id, created);
      return ok(structuredClone(created) as T);
    }

    if (expectedVersion === null || expectedVersion !== current.version) {
      return err({
        kind: 'version_conflict',
        id: value.id,
        expectedVersion: expectedVersion ?? 0,
        actualVersion: current.version,
      });
    }

    const updated = { ...structuredClone(value), version: current.version + 1 } as T;
    this.#records.set(updated.id, updated);
    return ok(structuredClone(updated) as T);
  }

  async softDelete(id: Id, expectedVersion: Version): Promise<Result<void, RepositoryError>> {
    const current = this.#records.get(id);
    if (current === undefined) {
      return err({ kind: 'not_found', id });
    }
    if (current.version !== expectedVersion) {
      return err({
        kind: 'version_conflict',
        id,
        expectedVersion,
        actualVersion: current.version,
      });
    }

    this.#records.set(id, {
      ...current,
      deletedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      version: current.version + 1,
    } as T);
    return ok(undefined);
  }
}
