import type { AttachmentMetadata, AttachmentReadGrant } from '@rpg/attachments';
import { isAllowedMime, renderKindFor } from '@rpg/attachments/policy';

/**
 * Pure viewer rules (feature 05 task 04, FR-008). Uploaded content is never placed in the
 * application document: images render through `<img>` (inert), documents open only as a top-level
 * navigation in a separate storage-origin context. A read URL on the application's own origin, or
 * any non-HTTP(S) scheme, is refused rather than rendered.
 */

export type ReadOutcome =
  | { readonly kind: 'granted'; readonly url: string; readonly expiresAt: string }
  | { readonly kind: 'unavailable' };

export type ViewerKind = 'image' | 'document' | 'unsupported';

export function viewerKindOf(mime: string): ViewerKind {
  return isAllowedMime(mime) ? renderKindFor(mime) : 'unsupported';
}

/** Only an HTTP(S) URL on an origin other than the application's may be loaded. */
export function isSeparateOriginUrl(url: string, appOrigin: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return (
    (parsed.protocol === 'https:' || parsed.protocol === 'http:') && parsed.origin !== appOrigin
  );
}

/**
 * Maps a read-grant response to what the viewer may do. A denial, a miss, a provider fault, a
 * malformed body and an unsafe URL all degrade to `unavailable`: never a blank or broken viewer,
 * and never a hint about whether a hidden attachment exists.
 */
export function readOutcomeOf(status: number, body: unknown, appOrigin: string): ReadOutcome {
  if (status !== 200 || typeof body !== 'object' || body === null) return { kind: 'unavailable' };
  const grant = body as Partial<AttachmentReadGrant>;
  if (
    typeof grant.url !== 'string' ||
    typeof grant.expiresAt !== 'string' ||
    !isSeparateOriginUrl(grant.url, appOrigin)
  ) {
    return { kind: 'unavailable' };
  }
  return { kind: 'granted', url: grant.url, expiresAt: grant.expiresAt };
}

export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export type ListedAttachment = Pick<
  AttachmentMetadata,
  'attachmentId' | 'filename' | 'mime' | 'size' | 'visibility'
>;
