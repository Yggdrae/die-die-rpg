import { type AttachmentRef, Id, Timestamp, Version, Visibility } from '@rpg/contracts';
import { type Static, Type } from '@sinclair/typebox';
import { ATTACHMENT_MIME_TYPES } from './policy.ts';

/**
 * Published attachment module contracts (`_prd.md` FR-013). None of them names a storage
 * provider, an object key, or carries file bytes. Route schemas use id-free copies.
 */

export const AttachmentOwnerRef = Type.Object(
  {
    resourceClass: Type.String({ pattern: '^[a-z][a-z0-9_]{0,63}$' }),
    resourceId: Id,
  },
  { additionalProperties: false },
);
export type AttachmentOwnerRef = Static<typeof AttachmentOwnerRef>;

export const Sha256Hex = Type.String({ pattern: '^[0-9a-f]{64}$' });

/**
 * Upload permission request. MIME and size are deliberately loose here: the file policy runs in
 * the service after authorization, so an unauthorized caller learns nothing, and an authorized one
 * gets a specific policy error.
 */
export const AttachmentUploadRequest = Type.Object(
  {
    owner: AttachmentOwnerRef,
    filename: Type.String({ minLength: 1, maxLength: 1024 }),
    mime: Type.String({ minLength: 1, maxLength: 255 }),
    size: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    checksum: Type.String({ minLength: 1, maxLength: 128 }),
    visibility: Visibility,
  },
  { additionalProperties: false },
);
export type AttachmentUploadRequest = Static<typeof AttachmentUploadRequest>;

/** Repeats the declared values, so a retry is idempotent and a mismatch changes nothing. */
export const AttachmentFinalizeRequest = Type.Object(
  {
    size: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    checksum: Type.String({ minLength: 1, maxLength: 128 }),
  },
  { additionalProperties: false },
);
export type AttachmentFinalizeRequest = Static<typeof AttachmentFinalizeRequest>;

export const AttachmentMime = Type.Union(ATTACHMENT_MIME_TYPES.map((mime) => Type.Literal(mime)));

/** Ready attachment metadata. Superset of the frozen `AttachmentRef`. */
export const AttachmentMetadata = Type.Object(
  {
    attachmentId: Id,
    campaignId: Id,
    owner: AttachmentOwnerRef,
    filename: Type.String(),
    mime: AttachmentMime,
    size: Type.Integer({ minimum: 1 }),
    checksum: Sha256Hex,
    status: Type.Literal('ready'),
    visibility: Visibility,
    version: Version,
    createdAt: Timestamp,
    createdBy: Id,
    updatedAt: Timestamp,
    updatedBy: Id,
    finalizedAt: Timestamp,
  },
  { additionalProperties: false },
);
export type AttachmentMetadata = Static<typeof AttachmentMetadata>;

export const AttachmentList = Type.Object(
  { items: Type.Array(AttachmentMetadata) },
  { additionalProperties: false },
);
export type AttachmentList = Static<typeof AttachmentList>;

export const UploadGrantView = Type.Object(
  {
    method: Type.Literal('PUT'),
    url: Type.String(),
    headers: Type.Record(Type.String(), Type.String()),
    expiresAt: Timestamp,
  },
  { additionalProperties: false },
);

export const AttachmentUploadPermission = Type.Object(
  {
    attachment: Type.Object(
      {
        attachmentId: Id,
        status: Type.Literal('pending'),
        /** Unfinalized uploads are collected after this. */
        expiresAt: Timestamp,
      },
      { additionalProperties: false },
    ),
    upload: UploadGrantView,
  },
  { additionalProperties: false },
);
export type AttachmentUploadPermission = Static<typeof AttachmentUploadPermission>;

export const AttachmentReadGrant = Type.Object(
  {
    attachmentId: Id,
    method: Type.Literal('GET'),
    url: Type.String(),
    expiresAt: Timestamp,
    mime: AttachmentMime,
    disposition: Type.Union([Type.Literal('inline'), Type.Literal('attachment')]),
  },
  { additionalProperties: false },
);
export type AttachmentReadGrant = Static<typeof AttachmentReadGrant>;

export function toAttachmentRef(metadata: AttachmentMetadata): AttachmentRef {
  return {
    attachmentId: metadata.attachmentId,
    mime: metadata.mime,
    size: metadata.size,
    status: metadata.status,
  };
}
