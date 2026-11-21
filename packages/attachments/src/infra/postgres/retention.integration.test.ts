import { afterAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import type { NewPendingAttachment } from '../../application.ts';
import { objectKeyFor } from '../../content.ts';
import { AttachmentManifestExporter } from '../../export.ts';
import { MemoryObjectStorage } from '../../memory.ts';
import { AttachmentReconciler, NO_RETAINED_ATTACHMENT_REFERENCES } from '../../reconciliation.ts';
import { fileBytes, GM, NOTE, ownerId, sha256 } from '../../testing.ts';
import { connectAttachmentDatabase, PostgresAttachmentRepository } from './repository.ts';

/**
 * Feature 05 task 06 against PostgreSQL (`_db.md`, Required Data Tests): the tombstone and its
 * 30-day deadline use database time, the purge boundary is exclusive, campaign deletion
 * tombstones under the same rule, purge deletes the object before the metadata, and attachment
 * metadata stays out of every sync publication (so the feature 03 watermark gate is vacuous).
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

async function ready(repository: PostgresAttachmentRepository, campaignId: string) {
  const id = crypto.randomUUID();
  const bytes = fileBytes('image/png');
  const input: NewPendingAttachment = {
    id,
    campaignId,
    ownerResourceClass: NOTE,
    ownerResourceId: ownerId(1),
    filename: 'map.png',
    mime: 'image/png',
    declaredSize: bytes.byteLength,
    declaredChecksum: sha256(bytes),
    objectKey: objectKeyFor(campaignId, id),
    visibility: { mode: 'everyone' },
    createdBy: GM,
  };
  await repository.insertPending(input);
  const row = await repository.markReady(campaignId, id, {
    size: bytes.byteLength,
    checksum: input.declaredChecksum,
    actorUserId: GM,
  });
  if (row === undefined) throw new Error('not ready');
  return { row, bytes };
}

describe.skipIf(connection === undefined)('PostgreSQL attachment retention', () => {
  test('the tombstone fixes purge_after at exactly 30 days of database time, once', async () => {
    const repository = new PostgresAttachmentRepository(db());
    const campaignId = freshCampaign();
    const { row } = await ready(repository, campaignId);
    const OTHER = '00000000-0000-4000-8000-0000000000c1';
    expect(
      await repository.markDeleted(campaignId, row.id, { expectedVersion: 2, actorUserId: GM }),
    ).toBeUndefined();
    const deleted = await repository.markDeleted(campaignId, row.id, {
      expectedVersion: 1,
      actorUserId: OTHER,
    });
    expect(deleted).toMatchObject({ version: 2, updatedBy: OTHER, status: 'ready' });
    const [window] = await db().execute<{ exact: boolean }>(sql`
      select purge_after - deleted_at = interval '30 days' as exact from attachments
      where id = ${row.id}
    `);
    expect(window?.exact).toBe(true);
    expect(
      await repository.markDeleted(campaignId, row.id, { expectedVersion: 2, actorUserId: GM }),
    ).toBeUndefined();
    expect((await repository.find(campaignId, row.id))?.purgeAfter).toEqual(deleted?.purgeAfter);
    expect(await repository.listReadyInCampaign(campaignId)).toEqual([]);
  });

  test('purge eligibility is exclusive at the deadline and hard-delete needs a due tombstone', async () => {
    const repository = new PostgresAttachmentRepository(db());
    const campaignId = freshCampaign();
    const { row: live } = await ready(repository, campaignId);
    const { row: edge } = await ready(repository, campaignId);
    const { row: due } = await ready(repository, campaignId);
    for (const id of [edge.id, due.id]) {
      await repository.markDeleted(campaignId, id, { expectedVersion: 1, actorUserId: GM });
    }
    await db().execute(sql`
      update attachments set deleted_at = now() - interval '30 days' + interval '1 minute',
        purge_after = now() + interval '1 minute' where id = ${edge.id}
    `);
    await db().execute(sql`
      update attachments set deleted_at = now() - interval '30 days' - interval '1 second',
        purge_after = now() - interval '1 second' where id = ${due.id}
    `);
    const eligible = (await repository.purgeDue(10_000)).map((row) => row.id);
    expect(eligible).toContain(due.id);
    expect(eligible).not.toContain(edge.id);
    expect(eligible).not.toContain(live.id);
    expect(await repository.hardDeleteTombstone(live.id)).toBe(false);
    expect(await repository.hardDeleteTombstone(edge.id)).toBe(false);
    expect(await repository.hardDeleteTombstone(due.id)).toBe(true);
    expect(await repository.hardDeleteTombstone(due.id)).toBe(false);
  });

  test('reconciler over PostgreSQL: campaign deletion cascade, object before metadata, no restore', async () => {
    const repository = new PostgresAttachmentRepository(db());
    const storage = new MemoryObjectStorage();
    const gone = freshCampaign();
    const kept = freshCampaign();
    const first = await ready(repository, gone);
    const second = await ready(repository, gone);
    const other = await ready(repository, kept);
    for (const entry of [first, second, other]) storage.put(entry.row.objectKey, entry.bytes);
    expect(await repository.campaignsWithLiveAttachments(100_000)).toEqual(
      expect.arrayContaining([gone, kept]),
    );
    const reconciler = new AttachmentReconciler({
      repository,
      storage,
      campaigns: { isDeleted: async (campaignId) => campaignId === gone },
      references: NO_RETAINED_ATTACHMENT_REFERENCES,
      batchSize: 100_000,
    });
    const report = await reconciler.run();
    expect(report.tombstoned).toBeGreaterThanOrEqual(2);
    const rows = await db().execute<{ id: string; exact: boolean }>(sql`
      select id, purge_after - deleted_at = interval '30 days' as exact from attachments
      where campaign_id = ${gone}
    `);
    expect(rows.map((row) => row.exact)).toEqual([true, true]);
    expect((await repository.find(kept, other.row.id))?.deletedAt).toBeUndefined();
    expect(storage.objects.size).toBe(3);

    await db().execute(sql`
      update attachments set purge_after = now() - interval '1 second' where campaign_id = ${gone}
    `);
    storage.failing.add('delete');
    await reconciler.run();
    expect(
      (await db().execute(sql`select id from attachments where campaign_id = ${gone}`)).length,
    ).toBe(2);
    storage.failing.delete('delete');
    await reconciler.run();
    expect(storage.objects.has(first.row.objectKey)).toBe(false);
    expect(storage.objects.has(second.row.objectKey)).toBe(false);
    expect(
      (await db().execute(sql`select id from attachments where campaign_id = ${gone}`)).length,
    ).toBe(0);
    expect(storage.objects.has(other.row.objectKey)).toBe(true);
  });

  test('diagnostics and the export manifest read the same metadata', async () => {
    const repository = new PostgresAttachmentRepository(db());
    const campaignId = freshCampaign();
    const { row } = await ready(repository, campaignId);
    const orphan = objectKeyFor(campaignId, crypto.randomUUID());
    expect(await repository.knownObjectKeys([row.objectKey, orphan])).toEqual(
      new Set([row.objectKey]),
    );
    expect((await repository.readyLive(100_000)).map((entry) => entry.id)).toContain(row.id);
    const chunk = await new AttachmentManifestExporter(repository).export(campaignId);
    expect(chunk.payload).toMatchObject({
      campaignId,
      binaries: 'excluded',
      entries: [{ attachmentId: row.id, checksum: row.declaredChecksum, size: row.declaredSize }],
    });
    expect(JSON.stringify(chunk)).not.toContain(row.objectKey);
  });

  test('a device never receives an object key or an attachment that is not ready', async () => {
    const config = await Bun.file(
      new URL('../../../../../infra/powersync/sync-config.yaml', import.meta.url),
    ).text();
    const [query] = config.split('- >-').filter((block) => /FROM attachments\b/.test(block));
    expect(query).toBeDefined();
    expect(query).not.toContain('object_key');
    expect(query).toContain("attachments.status = 'ready'");
    expect(query).toContain('attachments.deleted_at IS NULL');
    expect(query).toContain(`m.role IN '["owner","gm"]'`);
  });
});
