export const LOCAL_SCHEMA_VERSION = 1;

export const LOCAL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sync_campaign_state (
  campaign_id TEXT PRIMARY KEY,
  replica_state TEXT NOT NULL CHECK (replica_state IN ('populating','available','dropping','error')),
  last_server_cursor TEXT,
  last_sync_at TEXT,
  last_error_code TEXT
);
CREATE TABLE IF NOT EXISTS sync_records (
  table_name TEXT NOT NULL,
  id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  deleted_at TEXT,
  unresolved_conflict INTEGER NOT NULL DEFAULT 0 CHECK (unresolved_conflict IN (0,1)),
  PRIMARY KEY (table_name, id)
);
CREATE INDEX IF NOT EXISTS sync_records_campaign_idx
  ON sync_records (table_name, campaign_id, deleted_at, id);
CREATE TABLE IF NOT EXISTS sync_pending_mutations (
  mutation_id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  feature_id TEXT NOT NULL,
  table_name TEXT NOT NULL,
  record_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('insert','update','tombstone','semantic','resolution')),
  expected_version INTEGER,
  payload TEXT,
  causal_sequence INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','uploading','accepted','conflicted','rejected')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  recorded_at TEXT NOT NULL,
  terminal_at TEXT,
  UNIQUE (campaign_id, causal_sequence)
);
CREATE INDEX IF NOT EXISTS sync_pending_campaign_idx
  ON sync_pending_mutations (campaign_id, state, causal_sequence);
CREATE TABLE IF NOT EXISTS sync_audit_envelopes (
  mutation_id TEXT PRIMARY KEY REFERENCES sync_pending_mutations(mutation_id) ON DELETE CASCADE,
  payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sync_conflicts (
  conflict_id TEXT PRIMARY KEY,
  mutation_id TEXT NOT NULL UNIQUE REFERENCES sync_pending_mutations(mutation_id),
  campaign_id TEXT NOT NULL,
  feature_id TEXT NOT NULL,
  table_name TEXT NOT NULL,
  record_id TEXT NOT NULL,
  expected_version INTEGER NOT NULL,
  actual_version INTEGER NOT NULL,
  submitted_value TEXT NOT NULL,
  current_value TEXT NOT NULL,
  detected_at TEXT NOT NULL,
  resolution_state TEXT NOT NULL CHECK (resolution_state IN ('unresolved','deferred','resolved')),
  resolver_user_id TEXT,
  resolved_at TEXT
);
CREATE TABLE IF NOT EXISTS sync_tombstone_watermarks (
  campaign_id TEXT NOT NULL,
  table_name TEXT NOT NULL,
  tombstone_sequence INTEGER NOT NULL,
  replica_id TEXT NOT NULL,
  acknowledged_sequence INTEGER NOT NULL DEFAULT 0,
  revoked_at TEXT,
  PRIMARY KEY (campaign_id, table_name, tombstone_sequence, replica_id)
);
CREATE TABLE IF NOT EXISTS sync_long_text_holds (
  campaign_id TEXT NOT NULL,
  resource_class TEXT NOT NULL,
  record_id TEXT NOT NULL,
  field_path TEXT NOT NULL,
  holder_user_id TEXT NOT NULL,
  holder_session_id TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  renewed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  hold_version INTEGER NOT NULL,
  PRIMARY KEY (campaign_id, resource_class, record_id, field_path)
);
`;
