/**
 * The identity of each preserved import chunk on the device (`campaign_export_metadata`), never its
 * payload: enough for an offline export to refuse rather than silently lose a chunk only the
 * authority holds.
 */
export const PRESERVED_CHUNK_REPLICA_TABLES = {
  import_preserved_chunks: {
    columns: { campaign_id: 'text', module_id: 'text', chunk_version: 'text' },
    indexes: { campaign: ['campaign_id'] },
  },
} as const;
