import type { AttachmentMimeType } from './policy.ts';

/**
 * Provider-neutral object storage port (`_prd.md` FR-001). The domain and every consumer depend on
 * this, never on a vendor SDK; adapters live under `infra/`. Grants are opaque to callers: a URL,
 * a method, and the headers the client must send.
 */

export interface StorageGrant {
  readonly method: 'PUT' | 'GET';
  readonly url: string;
  /** Headers the client must send with the request (upload only). */
  readonly headers: Readonly<Record<string, string>>;
  readonly expiresAt: Date;
}

export interface UploadGrantRequest {
  readonly key: string;
  readonly contentType: AttachmentMimeType;
  readonly size: number;
  /** Lowercase hex SHA-256 the client declared. */
  readonly checksum: string;
  readonly expiresInSeconds: number;
}

export interface ReadGrantRequest {
  readonly key: string;
  /** Forced response type: the declared (verified) type, whatever the stored object says. */
  readonly contentType: AttachmentMimeType;
  readonly disposition: 'inline' | 'attachment';
  /** Safe filename for an `attachment` download. */
  readonly filename?: string;
  readonly expiresInSeconds: number;
}

export interface StoredObject {
  readonly size: number;
}

export interface ObjectStorage {
  createUploadGrant(request: UploadGrantRequest): Promise<StorageGrant>;
  createReadGrant(request: ReadGrantRequest): Promise<StorageGrant>;
  /** `undefined` when no object exists at `key`. */
  inspect(key: string): Promise<StoredObject | undefined>;
  read(key: string): AsyncIterable<Uint8Array>;
  /** Idempotent: a missing object is success. */
  delete(key: string): Promise<void>;
  /**
   * One page of keys under `prefix`, ascending, strictly after `after` (server-side
   * reconciliation diagnostics only; clients can never list the bucket). `after` on the result
   * continues the listing; absent means the listing is complete.
   */
  list(request: ObjectListRequest): Promise<ObjectListPage>;
}

export interface ObjectListRequest {
  readonly prefix: string;
  readonly after?: string;
  readonly limit: number;
}

export interface ObjectListPage {
  readonly keys: readonly string[];
  readonly after?: string;
}

/** Any provider fault (network, credentials, 5xx). Never carries a URL, key or secret. */
export class ObjectStorageUnavailable extends Error {
  constructor(readonly operation: string) {
    super(`object storage unavailable: ${operation}`);
    this.name = 'ObjectStorageUnavailable';
  }
}

/** Composition default when no provider is configured: every operation is a provider fault. */
export class UnconfiguredObjectStorage implements ObjectStorage {
  async createUploadGrant(): Promise<StorageGrant> {
    throw new ObjectStorageUnavailable('upload_grant');
  }

  async createReadGrant(): Promise<StorageGrant> {
    throw new ObjectStorageUnavailable('read_grant');
  }

  async inspect(): Promise<StoredObject | undefined> {
    throw new ObjectStorageUnavailable('inspect');
  }

  // biome-ignore lint/correctness/useYield: always a provider fault.
  async *read(): AsyncIterable<Uint8Array> {
    throw new ObjectStorageUnavailable('read');
  }

  async delete(): Promise<void> {
    throw new ObjectStorageUnavailable('delete');
  }

  async list(): Promise<ObjectListPage> {
    throw new ObjectStorageUnavailable('list');
  }
}

/** Upper bound any adapter accepts; the service asks for 600 s (upload) and 300 s (read). */
export const MAX_GRANT_SECONDS = 3600;

export function assertGrantLifetime(seconds: number): void {
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_GRANT_SECONDS) {
    throw new RangeError('invalid_grant_lifetime');
  }
}

/** RFC 6266/5987 `Content-Disposition` value; the filename never breaks out of the header. */
export function contentDisposition(
  disposition: 'inline' | 'attachment',
  filename?: string,
): string {
  if (disposition === 'inline' || filename === undefined) return disposition;
  const fallback = filename.replace(/[^\x20-\x7e]|["\\%;]/g, '_');
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
