import { Channel } from './channel.ts';
import type { SyncStatus } from './model.ts';

export class SyncStatusStore {
  readonly #changes = new Channel<SyncStatus>();
  #connected = true;
  #pendingCount = 0;
  #errorCode: string | undefined;
  #initialSyncProgress: number | undefined;
  #lastSyncAt: string | undefined;

  subscribe(listener: (status: SyncStatus) => void): () => void {
    listener(this.snapshot());
    return this.#changes.subscribe(listener);
  }

  snapshot(): SyncStatus {
    const base = {
      pendingCount: this.#pendingCount,
      connected: this.#connected,
      ...(this.#initialSyncProgress === undefined
        ? {}
        : { initialSyncProgress: this.#initialSyncProgress }),
      ...(this.#lastSyncAt === undefined ? {} : { lastSyncAt: this.#lastSyncAt }),
    };
    if (this.#errorCode !== undefined) {
      return { ...base, state: 'error', errorCode: this.#errorCode };
    }
    if (!this.#connected) return { ...base, state: 'offline' };
    if (this.#pendingCount > 0) return { ...base, state: 'pending' };
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
