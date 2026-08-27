import { type Static, Type } from '@sinclair/typebox';
import { Id } from './primitives.ts';

/** Upload lifecycle (`PRD.md` s.33). Only `ready` is a visible attachment. */
export const AttachmentStatus = Type.Union(
  [Type.Literal('pending'), Type.Literal('ready'), Type.Literal('failed')],
  { $id: 'AttachmentStatus' },
);
export type AttachmentStatus = Static<typeof AttachmentStatus>;

/**
 * Offline availability (`PRD.md` s.77).
 *
 * Nothing downloads a campaign of media without the user asking, so `cloud_only` is the
 * resting state and pinning is explicit.
 */
export const AttachmentOfflineState = Type.Union(
  [
    Type.Literal('cloud_only'),
    Type.Literal('cached'),
    Type.Literal('pinned'),
    Type.Literal('downloading'),
    Type.Literal('unavailable'),
  ],
  { $id: 'AttachmentOfflineState' },
);
export type AttachmentOfflineState = Static<typeof AttachmentOfflineState>;

/**
 * How a feature references an attachment without depending on feature 05 internals.
 *
 * Metadata lives in PostgreSQL, binary content in object storage (`PRD.md` s.32). Nothing
 * outside feature 05 knows which provider is behind it.
 */
export const AttachmentRef = Type.Object(
  {
    attachmentId: Id,
    mime: Type.String({ minLength: 1 }),
    size: Type.Integer({ minimum: 0 }),
    status: AttachmentStatus,
  },
  { $id: 'AttachmentRef' },
);
export type AttachmentRef = Static<typeof AttachmentRef>;
