import {
  assertGrantLifetime,
  contentDisposition,
  type ObjectListPage,
  type ObjectListRequest,
  type ObjectStorage,
  ObjectStorageUnavailable,
  type ReadGrantRequest,
  type StorageGrant,
  type StoredObject,
  type UploadGrantRequest,
} from '../../storage.ts';

/**
 * S3-compatible adapter on Bun's built-in `Bun.S3Client` (task 01: no SDK dependency; verified
 * against MinIO RELEASE.2025-09-07 under Bun 1.3.14, see `tasks/task_01.md`).
 *
 * What a presigned PUT can and cannot bind here (SigV4 query presign, `X-Amz-SignedHeaders=host`):
 * - bound: bucket, exact key, method, expiry;
 * - not bound: content length, content type, checksum. The grant still tells the client to send
 *   `content-type` and `x-amz-checksum-sha256` (MinIO rejects a body that does not match a sent
 *   checksum), but a client may omit them, so finalization re-verifies size, SHA-256 and the file
 *   signature from the stored bytes, and abandoned bytes are collected.
 *
 * Read grants force `response-content-type` and `response-content-disposition`; both are signed
 * query parameters, so a stored object labelled `text/html` is still served as the declared type.
 */
export interface S3StorageConfig {
  readonly endpoint: string;
  readonly bucket: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

export class BunS3ObjectStorage implements ObjectStorage {
  readonly #client: Bun.S3Client;
  readonly #now: () => Date;

  constructor(config: S3StorageConfig, now: () => Date = () => new Date()) {
    this.#client = new Bun.S3Client({
      endpoint: config.endpoint,
      bucket: config.bucket,
      region: config.region,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    });
    this.#now = now;
  }

  async createUploadGrant(request: UploadGrantRequest): Promise<StorageGrant> {
    assertGrantLifetime(request.expiresInSeconds);
    const issuedAt = this.#now();
    const url = this.#sign('presign_upload', () =>
      this.#client.presign(request.key, { method: 'PUT', expiresIn: request.expiresInSeconds }),
    );
    return {
      method: 'PUT',
      url,
      headers: {
        'content-type': request.contentType,
        'x-amz-checksum-sha256': Buffer.from(request.checksum, 'hex').toString('base64'),
      },
      expiresAt: new Date(issuedAt.getTime() + request.expiresInSeconds * 1000),
    };
  }

  async createReadGrant(request: ReadGrantRequest): Promise<StorageGrant> {
    assertGrantLifetime(request.expiresInSeconds);
    const issuedAt = this.#now();
    const url = this.#sign('presign_read', () =>
      this.#client.presign(request.key, {
        method: 'GET',
        expiresIn: request.expiresInSeconds,
        type: request.contentType,
        contentDisposition: contentDisposition(request.disposition, request.filename),
      }),
    );
    return {
      method: 'GET',
      url,
      headers: {},
      expiresAt: new Date(issuedAt.getTime() + request.expiresInSeconds * 1000),
    };
  }

  async inspect(key: string): Promise<StoredObject | undefined> {
    try {
      const stat = await this.#client.file(key).stat();
      return { size: stat.size };
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw new ObjectStorageUnavailable('inspect');
    }
  }

  async *read(key: string): AsyncIterable<Uint8Array> {
    let stream: ReadableStream<Uint8Array>;
    try {
      stream = this.#client.file(key).stream();
    } catch {
      throw new ObjectStorageUnavailable('read');
    }
    try {
      for await (const chunk of stream) yield chunk;
    } catch {
      throw new ObjectStorageUnavailable('read');
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.#client.file(key).delete();
    } catch (error) {
      if (isMissing(error)) return;
      throw new ObjectStorageUnavailable('delete');
    }
  }

  async list(request: ObjectListRequest): Promise<ObjectListPage> {
    let response: Awaited<ReturnType<Bun.S3Client['list']>>;
    try {
      response = await this.#client.list({
        prefix: request.prefix,
        maxKeys: request.limit,
        ...(request.after === undefined ? {} : { startAfter: request.after }),
      });
    } catch {
      throw new ObjectStorageUnavailable('list');
    }
    const keys = (response.contents ?? []).map((entry) => entry.key).sort();
    return response.isTruncated === true && keys.length > 0
      ? { keys, after: keys.at(-1) }
      : { keys };
  }

  #sign(operation: string, sign: () => string): string {
    try {
      return sign();
    } catch {
      throw new ObjectStorageUnavailable(operation);
    }
  }
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'NoSuchKey'
  );
}

/** Configuration from the environment names in `.env.example`; dev defaults match `compose.yaml`. */
export function s3ConfigFromEnv(env: Record<string, string | undefined>): S3StorageConfig {
  return {
    endpoint: env.S3_ENDPOINT ?? 'http://localhost:9000',
    bucket: env.S3_BUCKET ?? 'rpg-attachments',
    region: env.S3_REGION ?? 'us-east-1',
    accessKeyId: env.S3_ACCESS_KEY_ID ?? 'rpg-attachments',
    secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? 'rpg_attachments_dev_secret',
  };
}
