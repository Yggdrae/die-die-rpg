import type { AuditEventDeclaration } from '@rpg/audit';
import { Type } from '@sinclair/typebox';

/**
 * Feature 05 audit contributions (feature 06 FR-005, FR-006). `attachment.uploaded` is recorded
 * once per finalized attachment and `attachment.deleted` once per tombstone, both on the owner,
 * with the attachment's Visibility as the snapshot. The payload carries type and size only: a
 * filename follows its attachment's visibility and is never copied into history.
 */
export const ATTACHMENT_AUDIT_ACTIONS = {
  uploaded: 'attachment.uploaded',
  deleted: 'attachment.deleted',
} as const;

const KINDS: Readonly<Record<string, string>> = {
  'application/pdf': 'a PDF',
  'image/jpeg': 'a JPEG image',
  'image/png': 'a PNG image',
  'image/webp': 'a WebP image',
};

function sizeText(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) return undefined;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function describe(verb: string, file: Readonly<Record<string, unknown>> | undefined): string {
  const kind = typeof file?.mime === 'string' ? KINDS[file.mime] : undefined;
  const size = sizeText(file?.size);
  const what = kind ?? 'a file';
  return size === undefined ? `${verb} ${what}.` : `${verb} ${what} (${size}).`;
}

const FILE_PAYLOAD = Type.Object({
  mime: Type.Optional(Type.String()),
  size: Type.Optional(Type.Integer()),
});

export const ATTACHMENT_AUDIT_DECLARATIONS: readonly AuditEventDeclaration[] = [
  {
    action: ATTACHMENT_AUDIT_ACTIONS.uploaded,
    version: 1,
    payload: FILE_PAYLOAD,
    render: ({ after }) => ({ text: describe('Attached', after) }),
  },
  {
    action: ATTACHMENT_AUDIT_ACTIONS.deleted,
    version: 1,
    payload: FILE_PAYLOAD,
    render: ({ before }) => ({ text: describe('Removed', before) }),
  },
];
