/**
 * Device replica tables of feature 16 (`_db.md` "Offline and Sync"), in provider-neutral column
 * terms. They are exactly the approved projections of the `authorized_content` stream: the API's
 * `SYNC_RULE_BINDINGS` are built from these column lists (`id` first), and the web app passes the
 * tables to the browser replica schema (`BrowserSyncSession.open({ tables })`). JSON columns
 * (`tags`, `fields`, `metadata`, `visibility_targets`) arrive as text; the local repository parses
 * and validates them before returning records.
 */

export type ReplicaColumnType = 'text' | 'integer' | 'real';

export interface ReplicaTableDefinition {
  readonly columns: Readonly<Record<string, ReplicaColumnType>>;
  readonly indexes?: Readonly<Record<string, readonly string[]>>;
}

const ENVELOPE = {
  campaign_id: 'text',
  name: 'text',
  tags: 'text',
  metadata: 'text',
  visibility_mode: 'text',
  visibility_targets: 'text',
  version: 'integer',
  created_at: 'text',
  updated_at: 'text',
  created_by: 'text',
  updated_by: 'text',
  deleted_at: 'text',
} as const satisfies Record<string, ReplicaColumnType>;

export const CONTENT_REPLICA_TABLES = {
  content_entities: {
    columns: {
      campaign_id: ENVELOPE.campaign_id,
      type: 'text',
      name: ENVELOPE.name,
      summary: 'text',
      description: 'text',
      tags: ENVELOPE.tags,
      fields: 'text',
      metadata: ENVELOPE.metadata,
      visibility_mode: ENVELOPE.visibility_mode,
      visibility_targets: ENVELOPE.visibility_targets,
      version: ENVELOPE.version,
      created_at: ENVELOPE.created_at,
      updated_at: ENVELOPE.updated_at,
      created_by: ENVELOPE.created_by,
      updated_by: ENVELOPE.updated_by,
      deleted_at: ENVELOPE.deleted_at,
    },
    indexes: { campaign_type: ['campaign_id', 'type'], campaign_name: ['campaign_id', 'name'] },
  },
  content_personal_notes: {
    columns: {
      campaign_id: ENVELOPE.campaign_id,
      author_user_id: 'text',
      name: ENVELOPE.name,
      body: 'text',
      tags: ENVELOPE.tags,
      metadata: ENVELOPE.metadata,
      visibility_mode: ENVELOPE.visibility_mode,
      visibility_targets: ENVELOPE.visibility_targets,
      version: ENVELOPE.version,
      created_at: ENVELOPE.created_at,
      updated_at: ENVELOPE.updated_at,
      created_by: ENVELOPE.created_by,
      updated_by: ENVELOPE.updated_by,
      deleted_at: ENVELOPE.deleted_at,
    },
    indexes: { campaign_author: ['campaign_id', 'author_user_id'] },
  },
  content_entity_relationships: {
    columns: {
      campaign_id: ENVELOPE.campaign_id,
      source_entity_id: 'text',
      target_entity_id: 'text',
      kind: 'text',
      visibility_mode: ENVELOPE.visibility_mode,
      visibility_targets: ENVELOPE.visibility_targets,
      version: ENVELOPE.version,
      created_at: ENVELOPE.created_at,
      updated_at: ENVELOPE.updated_at,
      created_by: ENVELOPE.created_by,
      updated_by: ENVELOPE.updated_by,
      deleted_at: ENVELOPE.deleted_at,
    },
    indexes: {
      campaign_source: ['campaign_id', 'source_entity_id'],
      campaign_target: ['campaign_id', 'target_entity_id'],
    },
  },
} as const satisfies Record<string, ReplicaTableDefinition>;

/** Approved replicated columns of a content table, `id` first (stream projection order). */
export function replicaProjection(table: keyof typeof CONTENT_REPLICA_TABLES): string[] {
  return ['id', ...Object.keys(CONTENT_REPLICA_TABLES[table].columns)];
}

/** Feature/table keys shared by the device repositories and the authority mutation appliers. */
export const CONTENT_SYNC_FEATURE_ID = 'content';
export const ENTITY_REPLICA_TABLE = 'content_entities';
export const PERSONAL_NOTE_REPLICA_TABLE = 'content_personal_notes';
export const RELATIONSHIP_REPLICA_TABLE = 'content_entity_relationships';
