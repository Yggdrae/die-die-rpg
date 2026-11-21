import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import type { DeferredConflict, EntityEnvelope } from '@rpg/contracts';
import {
  type BrowserRecordCodec,
  BrowserReplicaStore,
  type BrowserSqlDatabase,
  type BrowserSqlTransaction,
  BrowserSyncedRepository,
} from './browser.ts';

/**
 * Feature 16 task 11 (feature 03 additive): the browser `SyncedRepository` over a feature-owned
 * replica table, local version check, audit envelope, tombstone, conflict channel and the browser
 * conflict resolution (keep authority / resubmit). Plain SQLite stands in for the PowerSync views.
 */

function sqlite(): BrowserSqlDatabase & { raw: Database } {
  const raw = new Database(':memory:');
  raw.exec(`
    CREATE TABLE fixture_records (id TEXT PRIMARY KEY, campaign_id TEXT, name TEXT, owner_note TEXT,
      visibility_mode TEXT, version INTEGER, updated_at TEXT, deleted_at TEXT);
    CREATE TABLE sync_pending_mutations (id TEXT PRIMARY KEY, campaign_id TEXT, feature_id TEXT,
      table_name TEXT, record_id TEXT, operation TEXT, expected_version INTEGER, payload TEXT,
      causal_sequence INTEGER, state TEXT, attempt_count INTEGER, next_attempt_at TEXT,
      recorded_at TEXT, terminal_at TEXT);
    CREATE TABLE sync_conflicts (id TEXT PRIMARY KEY, mutation_id TEXT, campaign_id TEXT,
      feature_id TEXT, table_name TEXT, record_id TEXT, expected_version INTEGER,
      actual_version INTEGER, submitted_value TEXT, current_value TEXT, detected_at TEXT,
      resolution_state TEXT, resolver_user_id TEXT, resolved_at TEXT);
    CREATE TABLE sync_campaign_state (id TEXT PRIMARY KEY, campaign_id TEXT, replica_state TEXT,
      last_server_cursor TEXT, last_sync_at TEXT, last_error_code TEXT, replica_id TEXT);
    CREATE TABLE sync_long_text_holds (id TEXT PRIMARY KEY, campaign_id TEXT, resource_class TEXT,
      record_id TEXT, field_path TEXT, holder_user_id TEXT, acquired_at TEXT, renewed_at TEXT,
      expires_at TEXT, version INTEGER);
  `);
  const tx: BrowserSqlTransaction = {
    async execute(sql, parameters = []) {
      raw.query(sql).run(...(parameters as never[]));
    },
    async getAll<T>(sql: string, parameters: unknown[] = []) {
      return raw.query(sql).all(...(parameters as never[])) as T[];
    },
    async getOptional<T>(sql: string, parameters: unknown[] = []) {
      return (raw.query(sql).get(...(parameters as never[])) as T | null) ?? null;
    },
  };
  return {
    raw,
    ...tx,
    async writeTransaction(callback) {
      raw.exec('BEGIN');
      try {
        const result = await callback(tx);
        raw.exec('COMMIT');
        return result;
      } catch (error) {
        raw.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

interface FixtureRecord extends EntityEnvelope {
  readonly ownerNote: string;
}

const CAMPAIGN = '00000000-0000-4000-8000-0000000016c1';
const USER = '00000000-0000-4000-8000-0000000016a1';
const RECORD = '00000000-0000-4000-8000-0000000016d1';

const codec: BrowserRecordCodec<FixtureRecord> = {
  toRow: (record) => ({
    campaign_id: record.campaignId,
    name: record.name,
    owner_note: record.ownerNote,
    visibility_mode: record.visibility.mode,
    version: record.version,
    updated_at: record.updatedAt,
    deleted_at: record.deletedAt ?? null,
  }),
  fromRow: (row) =>
    typeof row.name !== 'string'
      ? undefined
      : {
          id: String(row.id),
          campaignId: String(row.campaign_id),
          type: 'fixture',
          name: row.name,
          tags: [],
          metadata: {},
          visibility: { mode: row.visibility_mode === 'everyone' ? 'everyone' : 'gm_only' },
          version: Number(row.version),
          createdAt: '2026-10-29T10:00:00Z',
          createdBy: USER,
          updatedAt: String(row.updated_at),
          updatedBy: USER,
          ownerNote: String(row.owner_note),
          ...(row.deleted_at === null ? {} : { deletedAt: String(row.deleted_at) }),
        },
  // The authority owns `ownerNote` (as feature 04 owns Visibility for content).
  resubmitValue: (submitted, current) => ({
    ...(submitted as object),
    ownerNote: (current as FixtureRecord).ownerNote,
  }),
};

function record(name: string, version = 1): FixtureRecord {
  return {
    id: RECORD,
    campaignId: CAMPAIGN,
    type: 'fixture',
    name,
    tags: [],
    metadata: {},
    visibility: { mode: 'gm_only' },
    version,
    createdAt: '2026-10-29T10:00:00Z',
    createdBy: USER,
    updatedAt: '2026-10-29T10:00:00Z',
    updatedBy: USER,
    ownerNote: 'authority',
  };
}

function setup() {
  const db = sqlite();
  const store = new BrowserReplicaStore(db, { featureTables: ['fixture_records'] });
  let written = 0;
  let ids = 0;
  const repository = new BrowserSyncedRepository<FixtureRecord>(store, {
    tableName: 'fixture_records',
    featureId: 'fixture',
    userId: USER,
    campaignId: CAMPAIGN,
    codec,
    written: () => {
      written += 1;
    },
    clock: () => new Date('2026-10-29T12:00:00.000Z'),
    createId: () => `00000000-0000-4000-8000-0000000017${(ids++).toString(16).padStart(2, '0')}`,
  });
  const queued = () =>
    db.raw
      .query(
        'SELECT record_id, operation, expected_version, payload, state FROM sync_pending_mutations ORDER BY causal_sequence',
      )
      .all() as {
      record_id: string;
      operation: string;
      expected_version: number | null;
      payload: string | null;
      state: string;
    }[];
  return { db, store, repository, queued, written: () => written };
}

describe('BrowserSyncedRepository (feature table)', () => {
  test('a create is readable at once and queued with its payload and audit envelope', async () => {
    const { repository, queued, written } = setup();
    const created = await repository.upsert(
      { ...record('Smuggler'), holdVersion: 3 } as never,
      null,
    );
    expect(created.ok && created.value.version).toBe(1);
    expect(created.ok && 'holdVersion' in created.value).toBe(false);
    const read = await repository.get(RECORD);
    expect(read.ok && read.value.name).toBe('Smuggler');
    const [mutation] = queued();
    expect(mutation?.operation).toBe('insert');
    expect(mutation?.expected_version).toBeNull();
    const payload = JSON.parse(mutation?.payload ?? '{}');
    expect(payload.value.name).toBe('Smuggler');
    expect(payload.value.holdVersion).toBe(3);
    expect(payload.audit).toMatchObject({
      campaignId: CAMPAIGN,
      action: 'fixture.created',
      targetType: 'fixture_records',
      targetId: RECORD,
      at: '2026-10-29T12:00:00Z',
      private: true,
    });
    expect(written()).toBe(1);
  });

  test('a stale or missing local version is refused synchronously and writes nothing', async () => {
    const { repository, queued } = setup();
    await repository.upsert(record('Smuggler'), null);
    const stale = await repository.upsert(record('Smuggler v2'), 3);
    expect(stale).toEqual({
      ok: false,
      error: { kind: 'version_conflict', id: RECORD, expectedVersion: 3, actualVersion: 1 },
    });
    const again = await repository.upsert(record('Duplicate'), null);
    expect(again.ok).toBe(false);
    const missing = await repository.upsert(
      { ...record('Ghost'), id: '00000000-0000-4000-8000-0000000016d9' },
      1,
    );
    expect(missing.ok || missing.error).toEqual({
      kind: 'not_found',
      id: '00000000-0000-4000-8000-0000000016d9',
    });
    expect(queued()).toHaveLength(1);
    const read = await repository.get(RECORD);
    expect(read.ok && read.value.name).toBe('Smuggler');
  });

  test('update and tombstone queue versioned mutations; list hides tombstones', async () => {
    const { repository, queued } = setup();
    await repository.upsert(record('Smuggler'), null);
    const updated = await repository.upsert(record('Smuggler (renamed)'), 1);
    expect(updated.ok && updated.value.version).toBe(2);
    expect((await repository.softDelete(RECORD, 2)).ok).toBe(true);
    expect(queued().map((row) => [row.operation, row.expected_version])).toEqual([
      ['insert', null],
      ['update', 1],
      ['tombstone', 2],
    ]);
    const listed = await repository.list(CAMPAIGN);
    expect(listed.ok && listed.value).toEqual([]);
    const all = await repository.list(CAMPAIGN, { includeDeleted: true });
    expect(all.ok && all.value[0]?.deletedAt).toBe('2026-10-29T12:00:00Z');
    expect((await repository.softDelete(RECORD, 2)).ok).toBe(false);
  });

  test('another campaign or an unregistered table is refused', async () => {
    const { repository, store } = setup();
    const foreign = await repository.upsert({ ...record('X'), campaignId: USER }, null);
    expect(foreign.ok).toBe(false);
    let message = '';
    try {
      await store.featureRows('sync_pending_mutations', CAMPAIGN);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe('unregistered_replica_table');
  });

  test('an upload conflict reaches the channel; keep authority resolves it without a write', async () => {
    const { repository, store, queued } = setup();
    const seen: DeferredConflict[] = [];
    repository.conflicts.subscribe((conflict) => seen.push(conflict));
    await repository.upsert(record('Smuggler'), null);
    const [mutation] = (await store.nextBatch())?.mutations ?? [];
    await store.applyOutcomes(
      [
        {
          mutationId: mutation?.mutationId ?? '',
          status: 'conflict',
          expectedVersion: 1,
          actualVersion: 4,
          currentValue: { ...record('Authority name', 4), ownerNote: 'kept' },
        },
      ],
      '2026-10-29T12:01:00Z',
    );
    expect(seen.map((conflict) => [conflict.table, conflict.actualVersion])).toEqual([
      ['fixture_records', 4],
    ]);
    const [conflict] = await repository.pendingConflicts();
    expect(conflict?.submittedValue).toMatchObject({ name: 'Smuggler' });
    expect(conflict?.currentValue).toMatchObject({ name: 'Authority name' });
    expect(await store.pendingCount()).toBe(1);
    expect(await store.unresolvedCount()).toBe(1);
    expect(
      (await repository.resolveConflict(conflict?.conflictId ?? '', 'keep_authority')).ok,
    ).toBe(true);
    expect(await repository.pendingConflicts()).toEqual([]);
    expect(await store.pendingCount()).toBe(0);
    expect(await store.unresolvedCount()).toBe(0);
    expect(queued()).toHaveLength(1);
    expect((await repository.resolveConflict(conflict?.conflictId ?? '', 'resubmit')).ok).toBe(
      false,
    );
  });

  test('resubmit queues the submitted value against the authority version', async () => {
    const { repository, store, queued } = setup();
    await repository.upsert(record('Smuggler'), null);
    const [mutation] = (await store.nextBatch())?.mutations ?? [];
    await store.applyOutcomes(
      [
        {
          mutationId: mutation?.mutationId ?? '',
          status: 'conflict',
          expectedVersion: 1,
          actualVersion: 4,
          currentValue: { ...record('Authority name', 4), ownerNote: 'kept' },
        },
      ],
      '2026-10-29T12:01:00Z',
    );
    const [conflict] = await repository.pendingConflicts();
    await repository.deferConflict(conflict?.conflictId ?? '');
    expect((await repository.pendingConflicts())[0]?.resolutionState).toBe('deferred');
    expect((await repository.resolveConflict(conflict?.conflictId ?? '', 'resubmit')).ok).toBe(
      true,
    );
    const resubmitted = queued().at(-1);
    expect(resubmitted?.operation).toBe('update');
    expect(resubmitted?.expected_version).toBe(4);
    const payload = JSON.parse(resubmitted?.payload ?? '{}');
    expect(payload.value).toMatchObject({ name: 'Smuggler', version: 5, ownerNote: 'kept' });
    expect(payload.audit.action).toBe('sync.conflict_resolved');
    const read = await repository.get(RECORD);
    expect(read.ok && [read.value.name, read.value.version]).toEqual(['Smuggler', 5]);
    expect(await store.pendingCount()).toBe(1);
  });

  test('the replicated hold of a field is readable', async () => {
    const { db, store } = setup();
    db.raw
      .query(
        `INSERT INTO sync_long_text_holds VALUES ('h1', ?, 'campaign_entity', ?, 'description', ?,
          '2026-10-29T12:00:00Z', '2026-10-29T12:00:00Z', '2026-10-29T12:02:00Z', 2)`,
      )
      .run(CAMPAIGN, RECORD, USER);
    const field = {
      campaignId: CAMPAIGN,
      resourceClass: 'campaign_entity',
      recordId: RECORD,
      fieldPath: 'description',
    };
    expect(await store.longTextHold(field)).toEqual({
      holderUserId: USER,
      version: 2,
      expiresAt: '2026-10-29T12:02:00Z',
    });
    expect(await store.longTextHold({ ...field, fieldPath: 'body' })).toBeUndefined();
  });
});
