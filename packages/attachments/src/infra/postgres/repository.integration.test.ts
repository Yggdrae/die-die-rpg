import { afterAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { AttachmentService, type NewPendingAttachment } from '../../application.ts';
import { AttachmentCleanup } from '../../cleanup.ts';
import { objectKeyFor } from '../../content.ts';
import { MemoryObjectStorage } from '../../memory.ts';
import {
  CAMPAIGN,
  FixtureAuthorizer,
  fileBytes,
  GM,
  NOTE,
  ownerId,
  sha256,
} from '../../testing.ts';
import { connectAttachmentDatabase, PostgresAttachmentRepository } from './repository.ts';

/**
 * Feature 05 `_db.md`, Required Data Tests (metadata side). Rows use a fresh random campaign per
 * test and are removed in `afterAll`.
 */

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const candidate = databaseUrl === undefined ? undefined : connectAttachmentDatabase(databaseUrl);
const connection = await (async () => {
  if (candidate === undefined) return undefined;
  try {
    await candidate.db.execute(sql`select 1 from attachments limit 1`);
    return candidate;
  } catch {
    await candidate.close();
    return undefined;
  }
})();
const campaigns: string[] = [];

afterAll(async () => {
  if (connection === undefined) return;
  for (const campaignId of campaigns) {
    await connection.db.execute(sql`delete from attachments where campaign_id = ${campaignId}`);
  }
  await connection.close();
});

function db() {
  if (connection === undefined) throw new Error('database unavailable');
  return connection.db;
}

function freshCampaign(): string {
  const campaignId = crypto.randomUUID();
  campaigns.push(campaignId);
  return campaignId;
}

function pending(campaignId: string, overrides: Partial<NewPendingAttachment> = {}) {
  const id = overrides.id ?? crypto.randomUUID();
  const bytes = fileBytes('image/png');
  return {
    id,
    campaignId,
    ownerResourceClass: NOTE,
    ownerResourceId: ownerId(1),
    filename: 'map.png',
    mime: 'image/png' as const,
    declaredSize: bytes.byteLength,
    declaredChecksum: sha256(bytes),
    objectKey: objectKeyFor(campaignId, id),
    visibility: { mode: 'everyone' as const },
    createdBy: GM,
    ...overrides,
  };
}

/** Raw insert so database checks are exercised without the application's own validation. */
async function rawInsert(campaignId: string, columns: Record<string, unknown>): Promise<string> {
  const id = crypto.randomUUID();
  const row = {
    filename: 'map.png',
    mime_type: 'image/png',
    declared_size: 10,
    checksum_hex: 'a'.repeat(64),
    status: 'pending',
    visibility_mode: 'everyone',
    visibility_targets: '[]',
    object_key: objectKeyFor(campaignId, id),
    verified_size: null,
    finalized_at: null,
    failed_at: null,
    deleted_at: null,
    purge_after: null,
    ...columns,
  };
  await db().execute(sql`
    insert into attachments (
      id, campaign_id, owner_resource_class, owner_resource_id, filename, mime_type,
      declared_size, verified_size, declared_checksum, verified_checksum, object_key, status,
      visibility_mode, visibility_targets, created_by, updated_by, finalized_at, failed_at,
      deleted_at, purge_after
    ) values (
      ${id}, ${campaignId}, ${NOTE}, ${ownerId(1)}, ${row.filename}, ${row.mime_type},
      ${row.declared_size}, ${row.verified_size}, decode(${row.checksum_hex}, 'hex'),
      ${row.verified_size === null ? null : sql`decode(${row.checksum_hex}, 'hex')`},
      ${row.object_key}, ${row.status}, ${row.visibility_mode}, ${row.visibility_targets}::jsonb,
      ${GM}, ${GM}, ${row.finalized_at}, ${row.failed_at}, ${row.deleted_at}, ${row.purge_after}
    )
  `);
  return id;
}

async function rejects(campaignId: string, columns: Record<string, unknown>): Promise<string> {
  try {
    await rawInsert(campaignId, columns);
    return 'accepted';
  } catch (error) {
    const cause = (error as { cause?: { constraint_name?: string } }).cause;
    return (
      cause?.constraint_name ?? (error as { constraint_name?: string }).constraint_name ?? 'error'
    );
  }
}

describe.skipIf(connection === undefined)('PostgreSQL attachment metadata', () => {
  test('no column can hold file bytes: only the two 32-byte digests are binary', async () => {
    const columns = await db().execute<{ column_name: string; data_type: string }>(sql`
      select column_name, data_type from information_schema.columns
      where table_schema = 'public' and table_name = 'attachments' order by column_name
    `);
    expect(
      columns.filter((column) => column.data_type === 'bytea').map((c) => c.column_name),
    ).toEqual(['declared_checksum', 'verified_checksum']);
    expect(columns.map((column) => column.column_name)).not.toContain('content');
    expect(await rejects(freshCampaign(), { checksum_hex: 'ab'.repeat(33) })).toBe(
      'attachments_declared_checksum_check',
    );
  });

  test('database checks reject unlisted MIME, >25 MB, bad checksum, invalid visibility and unsafe filenames', async () => {
    const campaignId = freshCampaign();
    const cases: [Record<string, unknown>, string][] = [
      [{ mime_type: 'image/svg+xml' }, 'attachments_mime_check'],
      [{ mime_type: 'text/html' }, 'attachments_mime_check'],
      [{ declared_size: 26_214_401 }, 'attachments_declared_size_check'],
      [{ declared_size: 0 }, 'attachments_declared_size_check'],
      [{ checksum_hex: 'ab'.repeat(16) }, 'attachments_declared_checksum_check'],
      [{ visibility_mode: 'secret' }, 'attachments_visibility_mode_check'],
      [
        { visibility_mode: 'players', visibility_targets: '[]' },
        'attachments_visibility_targets_check',
      ],
      [
        { visibility_mode: 'gm_only', visibility_targets: `["${GM}"]` },
        'attachments_visibility_targets_check',
      ],
      [{ visibility_targets: '{}' }, 'attachments_visibility_targets_check'],
      [{ filename: '' }, 'attachments_filename_check'],
      [{ filename: '   ' }, 'attachments_filename_check'],
      [{ filename: '..' }, 'attachments_filename_check'],
      [{ filename: 'a/b.png' }, 'attachments_filename_check'],
      [{ filename: 'a\\b.png' }, 'attachments_filename_check'],
      [{ filename: 'tab\tname.png' }, 'attachments_filename_check'],
      [{ filename: 'c1\u0085.png' }, 'attachments_filename_check'],
      [{ filename: 'é'.repeat(256) }, 'attachments_filename_check'],
      [{ object_key: 'campaigns/map.png' }, 'attachments_object_key_check'],
      [{ status: 'uploaded' }, 'attachments_status_check'],
      [{ status: 'ready' }, 'attachments_lifecycle_check'],
      [{ status: 'failed' }, 'attachments_lifecycle_check'],
      [
        { deleted_at: '2026-10-27T00:00:00Z', purge_after: '2026-11-26T00:00:00Z' },
        'attachments_deletion_check',
      ],
      [{ verified_size: 11 }, 'attachments_verified_size_check'],
    ];
    for (const [columns, constraint] of cases) {
      expect({ columns, result: await rejects(campaignId, columns) }).toEqual({
        columns,
        result: constraint,
      });
    }
    for (const filename of ['é'.repeat(255), 'Mapa – versão 2.pdf', '龍の地図.webp']) {
      expect(await rejects(campaignId, { filename })).toBe('accepted');
    }
  });

  test('only ready, non-deleted rows list; finalize transitions exactly once', async () => {
    const repository = new PostgresAttachmentRepository(db());
    const campaignId = freshCampaign();
    const first = await repository.insertPending(pending(campaignId));
    const second = await repository.insertPending(pending(campaignId));
    const owner = { resourceClass: NOTE, resourceId: ownerId(1) };
    expect(await repository.listReady(campaignId, owner)).toEqual([]);
    expect(first.status).toBe('pending');
    expect(first.pendingExpired).toBe(false);
    const verified = {
      size: first.declaredSize,
      checksum: first.declaredChecksum,
      actorUserId: GM,
    };
    // Concurrent finalizes: exactly one transition.
    const raced = await Promise.all([
      repository.markReady(campaignId, first.id, verified),
      repository.markReady(campaignId, first.id, verified),
    ]);
    expect(raced.filter((row) => row !== undefined)).toHaveLength(1);
    expect(await repository.markReady(campaignId, first.id, verified)).toBeUndefined();
    expect(
      await repository.markReady(campaignId, second.id, { ...verified, checksum: 'b'.repeat(64) }),
    ).toBeUndefined();
    expect((await repository.listReady(campaignId, owner)).map((row) => row.id)).toEqual([
      first.id,
    ]);
    expect(await repository.markFailed(campaignId, first.id)).toBe(false);
    expect(await repository.markFailed(campaignId, second.id)).toBe(true);
    const ready = await repository.find(campaignId, first.id);
    expect(ready).toMatchObject({
      status: 'ready',
      verifiedSize: first.declaredSize,
      verifiedChecksum: first.declaredChecksum,
      visibility: { mode: 'everyone' },
      version: 1,
    });
    expect(await repository.find(crypto.randomUUID(), first.id)).toBeUndefined();
    await db().execute(sql`
      update attachments set deleted_at = now(), purge_after = now() + interval '30 days'
      where id = ${first.id}
    `);
    expect(await repository.listReady(campaignId, owner)).toEqual([]);
  });

  test('pending expiry uses database time with an exclusive 24-hour boundary', async () => {
    const repository = new PostgresAttachmentRepository(db());
    const campaignId = freshCampaign();
    const fresh = await repository.insertPending(pending(campaignId));
    const edge = await repository.insertPending(pending(campaignId));
    const old = await repository.insertPending(pending(campaignId));
    await db().execute(sql`
      update attachments set created_at = now() - interval '24 hours' + interval '1 minute'
      where id = ${edge.id}
    `);
    await db().execute(sql`
      update attachments set created_at = now() - interval '24 hours' - interval '1 second'
      where id = ${old.id}
    `);
    expect((await repository.find(campaignId, fresh.id))?.pendingExpired).toBe(false);
    expect((await repository.find(campaignId, edge.id))?.pendingExpired).toBe(false);
    expect((await repository.find(campaignId, old.id))?.pendingExpired).toBe(true);
    expect(await repository.countActivePending(campaignId, GM)).toBe(2);
    const verified = { size: old.declaredSize, checksum: old.declaredChecksum, actorUserId: GM };
    expect(await repository.markReady(campaignId, old.id, verified)).toBeUndefined();
    const expired = (await repository.expiredPending(1000)).map((row) => row.id);
    expect(expired).toContain(old.id);
    expect(expired).not.toContain(edge.id);
  });

  test('cleanup collects abandoned uploads by database time and never touches ready rows', async () => {
    const repository = new PostgresAttachmentRepository(db());
    const storage = new MemoryObjectStorage();
    const campaignId = freshCampaign();
    const abandoned = await repository.insertPending(pending(campaignId));
    const finished = await repository.insertPending(pending(campaignId));
    storage.put(abandoned.objectKey, fileBytes('image/png'));
    storage.put(finished.objectKey, fileBytes('image/png'));
    await repository.markReady(campaignId, finished.id, {
      size: finished.declaredSize,
      checksum: finished.declaredChecksum,
      actorUserId: GM,
    });
    await db().execute(sql`
      update attachments set created_at = now() - interval '25 hours'
      where campaign_id = ${campaignId}
    `);
    const cleanup = new AttachmentCleanup({ repository, storage, batchSize: 1000 });
    const first = await cleanup.run();
    expect(first.expired).toBeGreaterThanOrEqual(1);
    expect((await repository.find(campaignId, abandoned.id))?.status).toBe('failed');
    expect(storage.objects.has(abandoned.objectKey)).toBe(false);
    await db().execute(sql`
      update attachments set created_at = now() - interval '7 days' - interval '1 second'
      where campaign_id = ${campaignId}
    `);
    await cleanup.run();
    expect(await repository.find(campaignId, abandoned.id)).toBeUndefined();
    expect((await repository.find(campaignId, finished.id))?.status).toBe('ready');
    expect(storage.objects.has(finished.objectKey)).toBe(true);
  });

  test('service over PostgreSQL: retrying finalize leaves one ready row', async () => {
    const repository = new PostgresAttachmentRepository(db());
    const storage = new MemoryObjectStorage();
    const authorizer = new FixtureAuthorizer();
    authorizer.putOwner(NOTE, ownerId(1), { mode: 'everyone' }, { campaignId: CAMPAIGN });
    const service = new AttachmentService({
      repository,
      storage,
      authorizer,
      members: authorizer.members,
      ownerClasses: [NOTE],
    });
    campaigns.push(CAMPAIGN);
    const bytes = fileBytes('image/webp', 300);
    const body = {
      owner: { resourceClass: NOTE, resourceId: ownerId(1) },
      filename: 'portrait.webp',
      mime: 'image/webp',
      size: bytes.byteLength,
      checksum: sha256(bytes),
      visibility: { mode: 'players' as const, playerIds: [GM] },
    };
    const permission = await service.requestUpload(GM, CAMPAIGN, body);
    if (!permission.ok) throw new Error(permission.error);
    const id = permission.value.attachment.attachmentId;
    const row = await repository.find(CAMPAIGN, id);
    if (row === undefined) throw new Error('missing row');
    storage.put(row.objectKey, bytes);
    const results = await Promise.all([
      service.finalize(GM, CAMPAIGN, id, body),
      service.finalize(GM, CAMPAIGN, id, body),
    ]);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(results[0]).toEqual(results[1]);
    const [count] = await db().execute<{ count: string }>(
      sql`select count(*) as count from attachments where id = ${id} and status = 'ready'`,
    );
    expect(Number(count?.count)).toBe(1);
  });
});
