import type { ReplicaPurged, ReplicaPurgeListener } from '@rpg/contracts';

/**
 * D-17 long-text drafts: text typed into a description or note body is kept on this device, per
 * user, keyed by campaign, Resource Class, record, and field. A draft is never queued and never
 * synchronized; it is saved only as a normal held write (feature 03 hold). It is removed by the
 * feature 03 `ReplicaPurgeListener` (revocation, campaign deletion, sign-out) and by `clear()`.
 */

export interface DraftKey {
  readonly campaignId: string;
  readonly resourceClass: string;
  readonly recordId: string;
  readonly fieldPath: string;
}

/** The `localStorage` subset the store needs (injectable for tests). */
export interface DraftStorage {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface ContentDraft {
  readonly text: string;
  readonly savedAt: string;
}

export class ContentDraftStore implements ReplicaPurgeListener {
  readonly #prefix: string;

  constructor(
    userId: string,
    private readonly storage: DraftStorage | undefined,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.#prefix = `rpg-content-draft:${userId}:`;
  }

  /** The signed-in user's store over `localStorage` (absent storage: drafts are not kept). */
  static forUser(userId: string): ContentDraftStore {
    let storage: DraftStorage | undefined;
    try {
      storage = globalThis.localStorage;
    } catch {
      storage = undefined;
    }
    return new ContentDraftStore(userId, storage);
  }

  #key(key: DraftKey): string {
    return `${this.#prefix}${[key.campaignId, key.resourceClass, key.recordId, key.fieldPath].join('|')}`;
  }

  get(key: DraftKey): ContentDraft | undefined {
    const raw = this.#read(this.#key(key));
    if (raw === null) return undefined;
    try {
      const value = JSON.parse(raw) as Partial<ContentDraft>;
      return typeof value.text === 'string' && typeof value.savedAt === 'string'
        ? { text: value.text, savedAt: value.savedAt }
        : undefined;
    } catch {
      return undefined;
    }
  }

  put(key: DraftKey, text: string): void {
    try {
      this.storage?.setItem(
        this.#key(key),
        JSON.stringify({ text, savedAt: this.clock().toISOString() }),
      );
    } catch {
      // Storage full or blocked: the text stays in the editor; nothing is queued either way.
    }
  }

  delete(key: DraftKey): void {
    this.#remove(this.#key(key));
  }

  /** Feature 03 removal signal: a purged campaign leaves no draft on this device. */
  async replicaPurged(event: ReplicaPurged): Promise<void> {
    this.#removeWhere((key) => key.startsWith(`${this.#prefix}${event.campaignId}|`));
  }

  /** Sign-out: every draft of this user. */
  clear(): void {
    this.#removeWhere((key) => key.startsWith(this.#prefix));
  }

  #keys(): string[] {
    const keys: string[] = [];
    if (this.storage === undefined) return keys;
    try {
      for (let index = 0; index < this.storage.length; index += 1) {
        const key = this.storage.key(index);
        if (key !== null) keys.push(key);
      }
    } catch {
      // Blocked storage holds nothing this store can reach.
    }
    return keys;
  }

  #removeWhere(match: (key: string) => boolean): void {
    for (const key of this.#keys()) if (match(key)) this.#remove(key);
  }

  #read(key: string): string | null {
    try {
      return this.storage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  }

  #remove(key: string): void {
    try {
      this.storage?.removeItem(key);
    } catch {
      // Nothing else to do: the key is unreadable too.
    }
  }
}

/** In-memory `DraftStorage` (tests and storage-less contexts). */
export class MemoryDraftStorage implements DraftStorage {
  readonly #items = new Map<string, string>();

  get length(): number {
    return this.#items.size;
  }

  key(index: number): string | null {
    return [...this.#items.keys()][index] ?? null;
  }

  getItem(key: string): string | null {
    return this.#items.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.#items.set(key, value);
  }

  removeItem(key: string): void {
    this.#items.delete(key);
  }
}
