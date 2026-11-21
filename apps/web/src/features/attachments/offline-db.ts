import type { LocalAttachment, OfflineAttachmentDb } from '@rpg/attachments/offline';

/**
 * Browser `OfflineAttachmentDb` on IndexedDB: one database per signed-in user with a `records`
 * store (the device-local state of `_db.md`, plus the metadata needed to open offline) and a
 * `bytes` store. Every write that touches both runs in one IndexedDB transaction, so verified
 * bytes and their pinned/cached state become visible together and a removal leaves nothing.
 * Outside the PowerSync replica on purpose: `ReplicaPurgeListener` is the contract for local
 * state beside the replica (feature 03).
 */

const RECORDS = 'records';
const BYTES = 'bytes';

export function offlineAttachmentDbName(userId: string): string {
  return `rpg-attachments-${userId}`;
}

function request<T>(operation: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    operation.onsuccess = () => resolve(operation.result);
    operation.onerror = () => reject(operation.error);
  });
}

function completion(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error('transaction_aborted'));
    transaction.onerror = () => reject(transaction.error);
  });
}

export class IndexedDbOfflineAttachmentDb implements OfflineAttachmentDb {
  private constructor(private readonly database: IDBDatabase) {}

  static async open(name: string, factory: IDBFactory = indexedDB) {
    const opening = factory.open(name, 1);
    opening.onupgradeneeded = () => {
      const database = opening.result;
      const records = database.createObjectStore(RECORDS, { keyPath: 'attachmentId' });
      records.createIndex('campaignId', 'campaignId');
      database.createObjectStore(BYTES);
    };
    return new IndexedDbOfflineAttachmentDb(await request(opening));
  }

  /** Deletes the whole per-user database (sign-out cleanup when no store is open). */
  static async destroy(name: string, factory: IDBFactory = indexedDB): Promise<void> {
    await request(factory.deleteDatabase(name));
  }

  close(): void {
    this.database.close();
  }

  async get(attachmentId: string): Promise<LocalAttachment | undefined> {
    const store = this.database.transaction(RECORDS, 'readonly').objectStore(RECORDS);
    return (await request(store.get(attachmentId))) as LocalAttachment | undefined;
  }

  async list(campaignId: string): Promise<LocalAttachment[]> {
    const store = this.database.transaction(RECORDS, 'readonly').objectStore(RECORDS);
    return (await request(store.index('campaignId').getAll(campaignId))) as LocalAttachment[];
  }

  async all(): Promise<LocalAttachment[]> {
    const store = this.database.transaction(RECORDS, 'readonly').objectStore(RECORDS);
    return (await request(store.getAll())) as LocalAttachment[];
  }

  async put(record: LocalAttachment, bytes?: Uint8Array | null): Promise<void> {
    const transaction = this.database.transaction([RECORDS, BYTES], 'readwrite');
    const done = completion(transaction);
    transaction.objectStore(RECORDS).put(record);
    if (bytes === null) transaction.objectStore(BYTES).delete(record.attachmentId);
    else if (bytes !== undefined) {
      transaction.objectStore(BYTES).put(bytes.slice().buffer, record.attachmentId);
    }
    await done;
  }

  async bytes(attachmentId: string): Promise<Uint8Array | undefined> {
    const store = this.database.transaction(BYTES, 'readonly').objectStore(BYTES);
    const value = (await request(store.get(attachmentId))) as ArrayBuffer | undefined;
    return value === undefined ? undefined : new Uint8Array(value);
  }

  async remove(attachmentIds: readonly string[]): Promise<void> {
    if (attachmentIds.length === 0) return;
    const transaction = this.database.transaction([RECORDS, BYTES], 'readwrite');
    const done = completion(transaction);
    for (const id of attachmentIds) {
      transaction.objectStore(RECORDS).delete(id);
      transaction.objectStore(BYTES).delete(id);
    }
    await done;
  }

  async clear(): Promise<void> {
    const transaction = this.database.transaction([RECORDS, BYTES], 'readwrite');
    const done = completion(transaction);
    transaction.objectStore(RECORDS).clear();
    transaction.objectStore(BYTES).clear();
    await done;
  }
}
