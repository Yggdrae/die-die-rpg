import { Channel } from './channel.ts';
import type { SyncStatus } from './model.ts';

/** `errorCode` reported while unresolved conflicts exist and no transport/upload error is set. */
export const UNRESOLVED_CONFLICTS_CODE = 'unresolved_conflicts';

export class SyncStatusStore {
  readonly #changes = new Channel<SyncStatus>();
  #connected = true;
  #pendingCount = 0;
  #unresolvedConflicts = 0;
  #errorCode: string | undefined;
  #initialSyncProgress: number | undefined;
  #lastSyncAt: string | undefined;

  subscribe(listener: (status: SyncStatus) => void): () => void {
    listener(this.snapshot());
    return this.#changes.subscribe(listener);
  }

  /**
   * Precedence: error (including unresolved conflicts) > offline > pending > synchronizing >
   * synchronized. `synchronized` therefore requires a connection, an empty queue, no conflict, no
   * error, and a completed initial synchronization.
   */
  snapshot(): SyncStatus {
    const base = {
      pendingCount: this.#pendingCount,
      connected: this.#connected,
      ...(this.#unresolvedConflicts === 0
        ? {}
        : { unresolvedConflicts: this.#unresolvedConflicts }),
      ...(this.#initialSyncProgress === undefined
        ? {}
        : { initialSyncProgress: this.#initialSyncProgress }),
      ...(this.#lastSyncAt === undefined ? {} : { lastSyncAt: this.#lastSyncAt }),
    };
    const errorCode =
      this.#errorCode ?? (this.#unresolvedConflicts > 0 ? UNRESOLVED_CONFLICTS_CODE : undefined);
    if (errorCode !== undefined) return { ...base, state: 'error', errorCode };
    if (!this.#connected) return { ...base, state: 'offline' };
    if (this.#pendingCount > 0) return { ...base, state: 'pending' };
    if (this.#initialSyncProgress !== undefined) return { ...base, state: 'synchronizing' };
    return { ...base, state: 'synchronized' };
  }

  setConnected(connected: boolean): void {
    this.#connected = connected;
    if (!connected) this.#errorCode = undefined;
    this.#publish();
  }

  setPendingCount(pendingCount: number): void {
    this.#pendingCount = Math.max(0, pendingCount);
    this.#publish();
  }

  setUnresolvedConflicts(count: number): void {
    this.#unresolvedConflicts = Math.max(0, count);
    this.#publish();
  }

  setInitialSyncProgress(progress: number | undefined): void {
    this.#initialSyncProgress =
      progress === undefined ? undefined : Math.max(0, Math.min(1, progress));
    this.#publish();
  }

  synchronized(at: string): void {
    this.#lastSyncAt = at;
    this.#errorCode = undefined;
    this.#initialSyncProgress = undefined;
    this.#publish();
  }

  fail(code: string): void {
    this.#errorCode = code;
    this.#publish();
  }

  clearError(): void {
    this.#errorCode = undefined;
    this.#publish();
  }

  #publish(): void {
    this.#changes.emit(this.snapshot());
  }
}
