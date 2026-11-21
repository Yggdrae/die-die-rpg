import { visibilityFromColumns, visibilityToColumns } from '@rpg/authorization';
import { Value } from '@sinclair/typebox/value';
import {
  type EntityRecord,
  EntityReplicaSchema,
  type PersonalNoteRecord,
  PersonalNoteReplicaSchema,
  type RelationshipRecord,
  RelationshipReplicaSchema,
} from './schemas.ts';
import {
  CONTENT_CONFIGURATION,
  PERSONAL_NOTE_RECORD_TYPE,
  RELATIONSHIP_RECORD_TYPE,
} from './types.ts';

/**
 * Feature 16 task 11: device record ↔ replica row mapping for `CONTENT_REPLICA_TABLES` (the
 * browser `SyncedRepository` codec). JSON columns arrive as text; timestamps arrive in the
 * provider's text form and are normalized to the contract `Timestamp`. A row that does not map to
 * a valid record (unknown Visibility shape, broken JSON, schema mismatch) is `undefined`: never
 * guessed, never shown.
 */

export type ReplicaRow = Readonly<Record<string, unknown>>;
export type ReplicaColumns = Readonly<Record<string, string | number | null>>;

export interface ContentRowCodec<T> {
  toRow(record: T): ReplicaColumns;
  fromRow(row: ReplicaRow): T | undefined;
  resubmitValue(submitted: unknown, current: unknown): unknown;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

/** Provider text (`2026-10-29 10:00:00.123456Z`, offsets) → `2026-10-29T10:00:00.123Z`. */
function timestamp(value: unknown): string | undefined {
  if (typeof value !== 'string' || value === '') return undefined;
  const parsed = new Date(value.includes('T') ? value : value.replace(' ', 'T'));
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function envelopeFromRow(row: ReplicaRow) {
  const visibility = visibilityFromColumns(row.visibility_mode, parseJson(row.visibility_targets));
  const createdAt = timestamp(row.created_at);
  const updatedAt = timestamp(row.updated_at);
  const deletedAt =
    row.deleted_at === null || row.deleted_at === undefined ? undefined : timestamp(row.deleted_at);
  if (
    visibility === undefined ||
    createdAt === undefined ||
    updatedAt === undefined ||
    (row.deleted_at !== null && row.deleted_at !== undefined && deletedAt === undefined)
  ) {
    return undefined;
  }
  return {
    id: row.id,
    campaignId: row.campaign_id,
    name: row.name,
    tags: parseJson(row.tags),
    metadata: parseJson(row.metadata),
    visibility,
    version: Number(row.version),
    createdAt,
    createdBy: row.created_by,
    updatedAt,
    updatedBy: row.updated_by,
    ...(deletedAt === undefined ? {} : { deletedAt }),
  };
}

function envelopeToRow(record: {
  readonly campaignId: string;
  readonly name: string;
  readonly tags: readonly string[];
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly visibility: EntityRecord['visibility'];
  readonly version: number;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly updatedAt: string;
  readonly updatedBy: string;
  readonly deletedAt?: string;
}): ReplicaColumns {
  const visibility = visibilityToColumns(record.visibility);
  return {
    campaign_id: record.campaignId,
    name: record.name,
    tags: JSON.stringify(record.tags),
    metadata: JSON.stringify(record.metadata),
    visibility_mode: visibility.mode,
    visibility_targets: JSON.stringify(visibility.targets),
    version: record.version,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    created_by: record.createdBy,
    updated_by: record.updatedBy,
    deleted_at: record.deletedAt ?? null,
  };
}

function checked<T>(schema: Parameters<typeof Value.Check>[0], value: unknown): T | undefined {
  return Value.Check(schema, value) ? (value as T) : undefined;
}

/** Visibility is feature 04's: a resubmitted edit keeps the authority's current Visibility. */
function keepAuthorityVisibility(submitted: unknown, current: unknown): unknown {
  if (typeof submitted !== 'object' || submitted === null) return submitted;
  if (typeof current !== 'object' || current === null || !('visibility' in current)) {
    return submitted;
  }
  return { ...submitted, visibility: current.visibility };
}

export const ENTITY_ROW_CODEC: ContentRowCodec<EntityRecord> = {
  toRow: (record) => ({
    ...envelopeToRow(record),
    type: record.type,
    summary: record.summary,
    description: record.description,
    fields: JSON.stringify(record.fields),
  }),
  fromRow: (row) => {
    const envelope = envelopeFromRow(row);
    if (envelope === undefined) return undefined;
    return checked<EntityRecord>(EntityReplicaSchema, {
      ...envelope,
      type: row.type,
      summary: row.summary ?? '',
      description: row.description ?? '',
      fields: parseJson(row.fields),
    });
  },
  resubmitValue: keepAuthorityVisibility,
};

export const PERSONAL_NOTE_ROW_CODEC: ContentRowCodec<PersonalNoteRecord> = {
  toRow: (record) => ({
    ...envelopeToRow(record),
    author_user_id: record.authorUserId,
    body: record.body,
  }),
  fromRow: (row) => {
    const envelope = envelopeFromRow(row);
    if (envelope === undefined) return undefined;
    return checked<PersonalNoteRecord>(PersonalNoteReplicaSchema, {
      ...envelope,
      type: PERSONAL_NOTE_RECORD_TYPE,
      authorUserId: row.author_user_id,
      body: row.body ?? '',
    });
  },
  resubmitValue: keepAuthorityVisibility,
};

export const RELATIONSHIP_ROW_CODEC: ContentRowCodec<RelationshipRecord> = {
  toRow: (record) => {
    const { name: _label, tags: _tags, metadata: _metadata, ...rest } = envelopeToRow(record);
    return {
      ...rest,
      source_entity_id: record.sourceEntityId,
      target_entity_id: record.targetEntityId,
      kind: record.kind,
    };
  },
  fromRow: (row) => {
    // The relationship replica has no name/tags/metadata columns: the label is mapped from the
    // kind by the reader (configuration), never stored.
    const label =
      typeof row.kind === 'string' ? CONTENT_CONFIGURATION.kind(row.kind)?.label : undefined;
    const envelope = envelopeFromRow({
      ...row,
      name: label ?? row.kind,
      tags: '[]',
      metadata: '{}',
    });
    if (envelope === undefined) return undefined;
    return checked<RelationshipRecord>(RelationshipReplicaSchema, {
      ...envelope,
      type: RELATIONSHIP_RECORD_TYPE,
      sourceEntityId: row.source_entity_id,
      targetEntityId: row.target_entity_id,
      kind: row.kind,
    });
  },
  resubmitValue: keepAuthorityVisibility,
};
