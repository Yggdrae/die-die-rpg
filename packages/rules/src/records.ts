import { visibilityFromColumns, visibilityToColumns } from '@rpg/authorization';
import { entitySchema, Id, Timestamp, type Visibility } from '@rpg/contracts';
import { type Static, Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

/**
 * Feature 14 marks (`_db.md`, D-08 to D-10): one row per (campaign, user, section) holding the bookmark and the last
 * view. Private to its owner: fixed Visibility `players:[user]` and an Ownership Rule on every capability.
 */

export const RULES_SYNC_FEATURE_ID = 'rules';
export const RULES_MARK_REPLICA_TABLE = 'rules_section_marks';
export const RULES_MARK_RECORD_TYPE = 'rules_section_mark';
export const MAX_SECTION_ID_LENGTH = 64;

const SectionId = Type.String({
  minLength: 1,
  maxLength: MAX_SECTION_ID_LENGTH,
  pattern: '^[A-Za-z][A-Za-z0-9_]*$',
});

export const RulesMarkReplicaSchema = entitySchema(
  {
    type: Type.Literal(RULES_MARK_RECORD_TYPE),
    userId: Id,
    sectionId: SectionId,
    bookmarked: Type.Boolean(),
    bookmarkChangedAt: Type.Optional(Timestamp),
    viewedAt: Type.Optional(Timestamp),
  },
  { additionalProperties: false },
);
export type RulesMarkRecord = Static<typeof RulesMarkReplicaSchema>;

/** The fixed Visibility of a user's mark (D-10). */
export function markVisibility(userId: string): Visibility {
  return { mode: 'players', playerIds: [userId] };
}

function sameVisibility(left: Visibility, right: Visibility): boolean {
  const a = visibilityToColumns(left);
  const b = visibilityToColumns(right);
  return a.mode === b.mode && a.targets.join(',') === b.targets.join(',');
}

/** `_db.md` shape rules beyond the schema. */
export function isValidRulesMark(candidate: unknown): candidate is RulesMarkRecord {
  if (!Value.Check(RulesMarkReplicaSchema, candidate)) return false;
  const record = candidate as RulesMarkRecord;
  if (record.name !== record.sectionId) return false;
  if (!sameVisibility(record.visibility, markVisibility(record.userId))) return false;
  if (record.bookmarked && record.bookmarkChangedAt === undefined) return false;
  return record.bookmarkChangedAt !== undefined || record.viewedAt !== undefined;
}

/**
 * D-08: the row ID derived from (campaign, user, section), UUID-shaped (SHA-256, version nibble 8), so every device
 * of one user addresses the same row and the authority refuses any other.
 */
export async function rulesMarkId(
  campaignId: string,
  userId: string,
  sectionId: string,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${RULES_MARK_RECORD_TYPE}\n${campaignId}\n${userId}\n${sectionId}`),
  );
  const hex = [...new Uint8Array(digest).slice(0, 16)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  const variant = ((Number.parseInt(hex.charAt(16), 16) & 0x3) | 0x8).toString(16);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `8${hex.slice(13, 16)}`,
    `${variant}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}

export interface MarkFacts {
  readonly bookmarked: boolean;
  readonly bookmarkChangedAt?: string;
  readonly viewedAt?: string;
}

function later(left: string | undefined, right: string | undefined): string | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Date.parse(right) > Date.parse(left) ? right : left;
}

/**
 * D-09: two marks of one row merge, commutatively: the bookmark with the later change (a tie keeps it bookmarked),
 * the later view. Never a conflict.
 */
export function mergeMarks(stored: MarkFacts, incoming: MarkFacts): MarkFacts {
  let bookmark: Pick<MarkFacts, 'bookmarked' | 'bookmarkChangedAt'> = stored;
  if (incoming.bookmarkChangedAt !== undefined) {
    const storedAt =
      stored.bookmarkChangedAt === undefined ? undefined : Date.parse(stored.bookmarkChangedAt);
    const incomingAt = Date.parse(incoming.bookmarkChangedAt);
    if (storedAt === undefined || incomingAt > storedAt) bookmark = incoming;
    else if (incomingAt === storedAt) {
      bookmark = { ...stored, bookmarked: stored.bookmarked || incoming.bookmarked };
    }
  }
  const viewedAt = later(stored.viewedAt, incoming.viewedAt);
  return {
    bookmarked: bookmark.bookmarked,
    ...(bookmark.bookmarkChangedAt === undefined
      ? {}
      : { bookmarkChangedAt: bookmark.bookmarkChangedAt }),
    ...(viewedAt === undefined ? {} : { viewedAt }),
  };
}

/* -------------------------------------------------------------------------- */
/* Device replica                                                             */
/* -------------------------------------------------------------------------- */

/** Exactly the approved projection of stream `authorized_rules_marks`. */
export const RULES_REPLICA_TABLES = {
  rules_section_marks: {
    columns: {
      campaign_id: 'text',
      user_id: 'text',
      section_id: 'text',
      bookmarked: 'integer',
      bookmark_changed_at: 'text',
      viewed_at: 'text',
      visibility_mode: 'text',
      visibility_targets: 'text',
      version: 'integer',
      created_at: 'text',
      updated_at: 'text',
      created_by: 'text',
      updated_by: 'text',
      deleted_at: 'text',
    },
    indexes: { campaign_user: ['campaign_id', 'user_id'] },
  },
} as const;

export function rulesReplicaProjection(): string[] {
  return ['id', ...Object.keys(RULES_REPLICA_TABLES.rules_section_marks.columns)];
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

/** Provider text (`2026-11-03 10:00:00.123Z`, offsets) to the contract `Timestamp`. */
function timestamp(value: unknown): string | undefined {
  if (typeof value !== 'string' || value === '') return undefined;
  const parsed = new Date(value.includes('T') ? value : value.replace(' ', 'T'));
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

export const RULES_MARK_ROW_CODEC = {
  toRow(record: RulesMarkRecord): Readonly<Record<string, string | number | null>> {
    const visibility = visibilityToColumns(record.visibility);
    return {
      campaign_id: record.campaignId,
      user_id: record.userId,
      section_id: record.sectionId,
      bookmarked: record.bookmarked ? 1 : 0,
      bookmark_changed_at: record.bookmarkChangedAt ?? null,
      viewed_at: record.viewedAt ?? null,
      visibility_mode: visibility.mode,
      visibility_targets: JSON.stringify(visibility.targets),
      version: record.version,
      created_at: record.createdAt,
      updated_at: record.updatedAt,
      created_by: record.createdBy,
      updated_by: record.updatedBy,
      deleted_at: record.deletedAt ?? null,
    };
  },
  fromRow(row: Readonly<Record<string, unknown>>): RulesMarkRecord | undefined {
    const visibility = visibilityFromColumns(
      row.visibility_mode,
      parseJson(row.visibility_targets),
    );
    const createdAt = timestamp(row.created_at);
    const updatedAt = timestamp(row.updated_at);
    if (visibility === undefined || createdAt === undefined || updatedAt === undefined) {
      return undefined;
    }
    const bookmarkChangedAt = timestamp(row.bookmark_changed_at);
    const viewedAt = timestamp(row.viewed_at);
    const deletedAt = timestamp(row.deleted_at);
    const record = {
      id: row.id,
      campaignId: row.campaign_id,
      type: RULES_MARK_RECORD_TYPE,
      name: row.section_id,
      tags: [],
      metadata: {},
      visibility,
      version: Number(row.version),
      createdAt,
      createdBy: row.created_by,
      updatedAt,
      updatedBy: row.updated_by,
      ...(deletedAt === undefined ? {} : { deletedAt }),
      userId: row.user_id,
      sectionId: row.section_id,
      bookmarked: row.bookmarked === 1 || row.bookmarked === true || row.bookmarked === '1',
      ...(bookmarkChangedAt === undefined ? {} : { bookmarkChangedAt }),
      ...(viewedAt === undefined ? {} : { viewedAt }),
    };
    return isValidRulesMark(record) ? record : undefined;
  },
};
