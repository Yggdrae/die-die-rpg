import type {
  AttachmentMetadata,
  AttachmentOwnerRef,
  AttachmentUploadPermission,
} from '@rpg/attachments';
import { checkFilePolicy, type FilePolicyViolation } from '@rpg/attachments/policy';
import type { Visibility } from '@rpg/contracts';
import { type ReadOutcome, readOutcomeOf } from './attachment-model.ts';

/**
 * Feature 05 client. API calls carry metadata only; file bytes go straight to the granted
 * storage URL without cookies or a referrer. The client-side policy check is a convenience: the
 * server repeats it before any grant exists.
 */

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

const defaultFetch: FetchLike = (input, init) => fetch(input, init);

function campaignPath(campaignId: string): string {
  return `/campaigns/${encodeURIComponent(campaignId)}`;
}

export async function listAttachments(
  campaignId: string,
  owner: AttachmentOwnerRef,
  fetchImpl: FetchLike = defaultFetch,
): Promise<{ kind: 'ok'; items: AttachmentMetadata[] } | { kind: 'unavailable' }> {
  try {
    const response = await fetchImpl(
      `${campaignPath(campaignId)}/resources/${encodeURIComponent(owner.resourceClass)}/${encodeURIComponent(owner.resourceId)}/attachments`,
      { credentials: 'include' },
    );
    if (!response.ok) return { kind: 'unavailable' };
    const body = (await response.json()) as { items?: AttachmentMetadata[] };
    return Array.isArray(body.items) ? { kind: 'ok', items: body.items } : { kind: 'unavailable' };
  } catch {
    return { kind: 'unavailable' };
  }
}

/** Asks for a fresh five-minute read URL; anything but a safe grant is `unavailable`. */
export async function requestRead(
  campaignId: string,
  attachmentId: string,
  disposition: 'inline' | 'attachment' = 'inline',
  fetchImpl: FetchLike = defaultFetch,
  appOrigin: string = globalThis.location?.origin ?? '',
): Promise<ReadOutcome> {
  try {
    const response = await fetchImpl(
      `${campaignPath(campaignId)}/attachments/${encodeURIComponent(attachmentId)}/read?disposition=${disposition}`,
      { credentials: 'include' },
    );
    const body: unknown = await response.json().catch(() => undefined);
    return readOutcomeOf(response.status, body, appOrigin);
  } catch {
    return { kind: 'unavailable' };
  }
}

export type UploadOutcome =
  | { readonly kind: 'attached'; readonly attachment: AttachmentMetadata }
  | { readonly kind: 'rejected'; readonly reason: FilePolicyViolation | string }
  | { readonly kind: 'failed'; readonly stage: 'permission' | 'upload' | 'finalize' };

export interface UploadInput {
  readonly campaignId: string;
  readonly owner: AttachmentOwnerRef;
  readonly file: Blob & { readonly name: string };
  readonly visibility: Visibility;
}

export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map((value) => value.toString(16).padStart(2, '0')).join('');
}

/** Request permission, upload directly to storage, finalize. */
export async function uploadAttachment(
  input: UploadInput,
  fetchImpl: FetchLike = defaultFetch,
): Promise<UploadOutcome> {
  const bytes = await input.file.arrayBuffer();
  const declared = {
    filename: input.file.name,
    mime: input.file.type,
    size: bytes.byteLength,
    checksum: await sha256Hex(bytes),
  };
  const violation = checkFilePolicy(declared);
  if (violation !== undefined) return { kind: 'rejected', reason: violation };

  const json = { 'content-type': 'application/json' };
  let permission: AttachmentUploadPermission;
  try {
    const response = await fetchImpl(`${campaignPath(input.campaignId)}/attachments/uploads`, {
      method: 'POST',
      credentials: 'include',
      headers: json,
      body: JSON.stringify({ owner: input.owner, visibility: input.visibility, ...declared }),
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as {
        code?: string;
        details?: { reason?: string };
      };
      return response.status === 404 || response.status >= 500
        ? { kind: 'failed', stage: 'permission' }
        : { kind: 'rejected', reason: body.details?.reason ?? body.code ?? 'rejected' };
    }
    permission = (await response.json()) as AttachmentUploadPermission;
  } catch {
    return { kind: 'failed', stage: 'permission' };
  }

  try {
    const stored = await fetchImpl(permission.upload.url, {
      method: permission.upload.method,
      headers: permission.upload.headers,
      body: bytes,
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
    if (!stored.ok) return { kind: 'failed', stage: 'upload' };
  } catch {
    return { kind: 'failed', stage: 'upload' };
  }

  try {
    const response = await fetchImpl(
      `${campaignPath(input.campaignId)}/attachments/${encodeURIComponent(permission.attachment.attachmentId)}/finalize`,
      {
        method: 'POST',
        credentials: 'include',
        headers: json,
        body: JSON.stringify({ size: declared.size, checksum: declared.checksum }),
      },
    );
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { code?: string };
      return response.status >= 500 || body.code === undefined
        ? { kind: 'failed', stage: 'finalize' }
        : { kind: 'rejected', reason: body.code };
    }
    const body = (await response.json()) as { attachment: AttachmentMetadata };
    return { kind: 'attached', attachment: body.attachment };
  } catch {
    return { kind: 'failed', stage: 'finalize' };
  }
}
