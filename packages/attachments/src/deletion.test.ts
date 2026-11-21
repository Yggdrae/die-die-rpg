import { beforeEach, describe, expect, test } from 'bun:test';
import type { CampaignAuditSubmission } from '@rpg/audit';
import type { Visibility } from '@rpg/contracts';
import { AttachmentService } from './application.ts';
import { ATTACHMENT_EXPORT_MODULE_ID, AttachmentManifestExporter } from './export.ts';
import { MemoryAttachmentRepository, MemoryObjectStorage } from './memory.ts';
import { DELETED_RETENTION_DAYS } from './policy.ts';
import {
  CAMPAIGN,
  CASEY,
  FixtureAuthorizer,
  fileBytes,
  GM,
  NOTE,
  OBSERVER,
  OTHER_CAMPAIGN,
  ownerId,
  ROWAN,
  SECRET,
  STRANGER,
  sha256,
} from './testing.ts';

/**
 * Feature 05 tasks 05–06 at the service boundary: the campaign offline set (`listCampaign`),
 * versioned deletion (`_bdd.md`, Deletion and Retention) and the P0 export manifest
 * (`_bdd.md`, Export receives an attachment manifest contribution).
 */

const NPC = ownerId(1);
const HIDDEN_NPC = ownerId(2);
const CASEY_SECRET = ownerId(3);
const EVERYONE: Visibility = { mode: 'everyone' };
const DAY = 86_400_000;

let clock: Date;
let repository: MemoryAttachmentRepository;
let storage: MemoryObjectStorage;
let authorizer: FixtureAuthorizer;
let audit: CampaignAuditSubmission[];
let service: AttachmentService;

function build(ownerClasses: readonly string[] = [NOTE, SECRET]) {
  service = new AttachmentService({
    repository,
    storage,
    authorizer,
    members: authorizer.members,
    audit: {
      recordCampaign: async (submission) => {
        audit.push(submission);
        return 'recorded';
      },
    },
    ownerClasses,
    now: () => clock,
  });
}

beforeEach(() => {
  clock = new Date('2026-10-27T12:00:00.000Z');
  repository = new MemoryAttachmentRepository(() => clock);
  storage = new MemoryObjectStorage(() => clock);
  authorizer = new FixtureAuthorizer();
  authorizer.putOwner(NOTE, NPC, EVERYONE);
  authorizer.putOwner(NOTE, HIDDEN_NPC, { mode: 'gm_only' });
  authorizer.putOwner(SECRET, CASEY_SECRET, EVERYONE, { authorUserId: CASEY });
  audit = [];
  build();
});

async function attach(
  options: {
    readonly owner?: string;
    readonly ownerClass?: string;
    readonly visibility?: Visibility;
    readonly uploader?: string;
    readonly mime?: 'image/png' | 'application/pdf';
    readonly filename?: string;
  } = {},
) {
  const mime = options.mime ?? 'image/png';
  const bytes = fileBytes(mime, 200);
  const body = {
    owner: { resourceClass: options.ownerClass ?? NOTE, resourceId: options.owner ?? NPC },
    filename: options.filename ?? 'harbor-map.png',
    mime,
    size: bytes.byteLength,
    checksum: sha256(bytes),
    visibility: options.visibility ?? EVERYONE,
  };
  const uploader = options.uploader ?? GM;
  const permission = await service.requestUpload(uploader, CAMPAIGN, body);
  if (!permission.ok) throw new Error(permission.error);
  const id = permission.value.attachment.attachmentId;
  const row = await repository.find(CAMPAIGN, id);
  if (row === undefined) throw new Error('missing');
  storage.put(row.objectKey, bytes);
  const ready = await service.finalize(uploader, CAMPAIGN, id, body);
  if (!ready.ok) throw new Error(ready.error);
  return { id, key: row.objectKey, version: ready.value.version };
}

describe('campaign offline set (task 05)', () => {
  test('lists only attachments each actor may read, with one fresh decision per owner', async () => {
    const open = await attach({ filename: 'open.png' });
    const gmOnly = await attach({ visibility: { mode: 'gm_only' }, filename: 'gm.png' });
    const onHidden = await attach({ owner: HIDDEN_NPC, filename: 'hidden-owner.png' });
    const forRowan = await attach({
      visibility: { mode: 'players', playerIds: [ROWAN] },
      filename: 'rowan.png',
    });
    const ids = async (userId: string) => {
      const result = await service.listCampaign(userId, CAMPAIGN);
      return result.ok ? result.value.map((item) => item.attachmentId).sort() : result.error;
    };
    expect(await ids(GM)).toEqual([open.id, gmOnly.id, onHidden.id, forRowan.id].sort());
    expect(await ids(ROWAN)).toEqual([open.id, forRowan.id].sort());
    expect(await ids(CASEY)).toEqual([open.id]);
    // Observers hold no read capability on the fixture classes.
    expect(await ids(OBSERVER)).toEqual([]);
    authorizer.requests.length = 0;
    await service.listCampaign(CASEY, CAMPAIGN);
    expect(authorizer.requests.map((entry) => entry.resourceId).sort()).toEqual(
      [NPC, HIDDEN_NPC].sort(),
    );
    expect(authorizer.requests.every((entry) => entry.capability === 'read')).toBe(true);
  });

  test('non-members and unknown campaigns get not_found, never an empty set', async () => {
    await attach();
    expect(await service.listCampaign(STRANGER, CAMPAIGN)).toEqual({
      ok: false,
      error: 'not_found',
    });
    expect(await service.listCampaign(GM, OTHER_CAMPAIGN)).toEqual({
      ok: false,
      error: 'not_found',
    });
    expect(await service.listCampaign('not-a-uuid', CAMPAIGN)).toEqual({
      ok: false,
      error: 'not_found',
    });
  });

  test('pending, failed and deleted attachments are never part of the offline set', async () => {
    const kept = await attach();
    const deleted = await attach({ filename: 'gone.png' });
    await service.delete(GM, CAMPAIGN, deleted.id, deleted.version);
    const bytes = fileBytes('image/png');
    await service.requestUpload(GM, CAMPAIGN, {
      owner: { resourceClass: NOTE, resourceId: NPC },
      filename: 'pending.png',
      mime: 'image/png',
      size: bytes.byteLength,
      checksum: sha256(bytes),
      visibility: EVERYONE,
    });
    const result = await service.listCampaign(GM, CAMPAIGN);
    expect(result.ok && result.value.map((item) => item.attachmentId)).toEqual([kept.id]);
  });

  test('without a registered owner class (production today) the set is empty', async () => {
    await attach();
    build([]);
    expect(await service.listCampaign(GM, CAMPAIGN)).toEqual({ ok: true, value: [] });
  });
});

describe('deletion (task 06)', () => {
  test('deleting publishes a tombstone without removing the object, and denies new reads at once', async () => {
    const attached = await attach();
    const deleted = await service.delete(GM, CAMPAIGN, attached.id, attached.version);
    expect(deleted).toEqual({
      ok: true,
      value: { attachmentId: attached.id, version: 2, deletedAt: clock.toISOString() },
    });
    const row = await repository.find(CAMPAIGN, attached.id);
    expect(row?.purgeAfter?.getTime()).toBe(clock.getTime() + DELETED_RETENTION_DAYS * DAY);
    expect(storage.objects.has(attached.key)).toBe(true);
    expect(storage.deleted).toEqual([]);
    const grants = storage.grants.length;
    expect(await service.issueRead(GM, CAMPAIGN, attached.id)).toEqual({
      ok: false,
      error: 'not_found',
    });
    expect(storage.grants.length).toBe(grants);
    expect(await service.resolve(GM, CAMPAIGN, attached.id)).toEqual({
      ok: false,
      error: 'not_found',
    });
    const listed = await service.list(GM, CAMPAIGN, { resourceClass: NOTE, resourceId: NPC });
    expect(listed).toEqual({ ok: true, value: [] });
  });

  test('repeating the delete keeps one tombstone, issues no URL and keeps the deadline', async () => {
    const attached = await attach();
    const first = await service.delete(GM, CAMPAIGN, attached.id, attached.version);
    const deadline = (await repository.find(CAMPAIGN, attached.id))?.purgeAfter?.getTime();
    clock = new Date(clock.getTime() + 5 * DAY);
    const grants = storage.grants.length;
    const again = await service.delete(GM, CAMPAIGN, attached.id, attached.version);
    const stale = await service.delete(GM, CAMPAIGN, attached.id, 99);
    expect(again).toEqual(first);
    expect(stale).toEqual(first);
    const row = await repository.find(CAMPAIGN, attached.id);
    expect(row?.version).toBe(2);
    expect(row?.purgeAfter?.getTime()).toBe(deadline ?? Number.NaN);
    expect(storage.grants.length).toBe(grants);
    expect([...repository.rows.values()].filter((r) => r.id === attached.id)).toHaveLength(1);
    // One history event: every retry carries the same origin, deduplicated by the recorder.
    const deletions = audit.filter((entry) => entry.event.action === 'attachment.deleted');
    expect(new Set(deletions.map((entry) => entry.originMutationId)).size).toBe(1);
  });

  test('history records type and size on the owner, never the filename', async () => {
    const attached = await attach({ filename: 'secret-villain.png' });
    await service.delete(GM, CAMPAIGN, attached.id, attached.version);
    const event = audit.find((entry) => entry.event.action === 'attachment.deleted');
    expect(event?.event).toMatchObject({
      action: 'attachment.deleted',
      targetType: NOTE,
      targetId: NPC,
      before: { mime: 'image/png', size: 200 },
    });
    expect(event?.targetVisibility).toEqual({ visibility: EVERYONE });
    expect(JSON.stringify(event)).not.toContain('secret-villain');
  });

  test('a stale version conflicts and changes nothing', async () => {
    const attached = await attach();
    expect(await service.delete(GM, CAMPAIGN, attached.id, attached.version + 1)).toEqual({
      ok: false,
      error: 'version_conflict',
    });
    expect((await repository.find(CAMPAIGN, attached.id))?.deletedAt).toBeUndefined();
  });

  test('actors who may not update, or may not see, the attachment get not_found', async () => {
    const open = await attach();
    const gmOnly = await attach({ visibility: { mode: 'gm_only' } });
    const caseys = await attach({ ownerClass: SECRET, owner: CASEY_SECRET, uploader: CASEY });
    const cases: [string, string, string][] = [
      // Players read fixture notes but cannot update them.
      [ROWAN, CAMPAIGN, open.id],
      [CASEY, CAMPAIGN, gmOnly.id],
      [STRANGER, CAMPAIGN, open.id],
      [OBSERVER, CAMPAIGN, open.id],
      // Author-private owner: even the GM cannot touch Casey's record.
      [GM, CAMPAIGN, caseys.id],
      [GM, OTHER_CAMPAIGN, open.id],
      [GM, CAMPAIGN, crypto.randomUUID()],
    ];
    for (const [userId, campaignId, id] of cases) {
      expect(await service.delete(userId, campaignId, id, 1)).toEqual({
        ok: false,
        error: 'not_found',
      });
    }
    expect(await service.delete(CASEY, CAMPAIGN, caseys.id, 1)).toMatchObject({ ok: true });
    expect([...repository.rows.values()].filter((row) => row.deletedAt !== undefined)).toHaveLength(
      1,
    );
  });

  test('a pending upload cannot be deleted through the attachment API', async () => {
    const bytes = fileBytes('image/png');
    const permission = await service.requestUpload(GM, CAMPAIGN, {
      owner: { resourceClass: NOTE, resourceId: NPC },
      filename: 'p.png',
      mime: 'image/png',
      size: bytes.byteLength,
      checksum: sha256(bytes),
      visibility: EVERYONE,
    });
    if (!permission.ok) throw new Error('no permission');
    expect(await service.delete(GM, CAMPAIGN, permission.value.attachment.attachmentId, 1)).toEqual(
      { ok: false, error: 'not_found' },
    );
  });
});

describe('export manifest (task 06, FR-014)', () => {
  test('one entry per ready attachment with checksum and Visibility; no bytes, keys or URLs', async () => {
    const open = await attach({ filename: 'map.png' });
    const restricted = await attach({
      mime: 'application/pdf',
      filename: 'letter.pdf',
      visibility: { mode: 'players', playerIds: [ROWAN] },
    });
    const deleted = await attach({ filename: 'gone.png' });
    await service.delete(GM, CAMPAIGN, deleted.id, deleted.version);
    const bytes = fileBytes('image/png');
    await service.requestUpload(GM, CAMPAIGN, {
      owner: { resourceClass: NOTE, resourceId: NPC },
      filename: 'pending.png',
      mime: 'image/png',
      size: bytes.byteLength,
      checksum: sha256(bytes),
      visibility: EVERYONE,
    });
    await service.issueRead(GM, CAMPAIGN, open.id);

    const exporter = new AttachmentManifestExporter(repository);
    const chunk = await exporter.export(CAMPAIGN);
    expect(chunk.moduleId).toBe(ATTACHMENT_EXPORT_MODULE_ID);
    expect(chunk.chunkVersion).toBe('1');
    const payload = chunk.payload as {
      binaries: string;
      entries: Record<string, unknown>[];
    };
    expect(payload.binaries).toBe('excluded');
    expect(payload.entries.map((entry) => entry.attachmentId).sort()).toEqual(
      [open.id, restricted.id].sort(),
    );
    const letter = payload.entries.find((entry) => entry.attachmentId === restricted.id);
    expect(Object.keys(letter ?? {}).sort()).toEqual(
      [
        'attachmentId',
        'checksum',
        'createdAt',
        'filename',
        'finalizedAt',
        'mime',
        'owner',
        'size',
        'version',
        'visibility',
      ].sort(),
    );
    expect(letter).toMatchObject({
      mime: 'application/pdf',
      size: 200,
      checksum: sha256(fileBytes('application/pdf', 200)),
      visibility: { mode: 'players', playerIds: [ROWAN] },
    });
    const text = JSON.stringify(chunk);
    for (const row of repository.rows.values()) expect(text).not.toContain(row.objectKey);
    expect(text).not.toContain('memory://');
    expect(text).not.toContain('campaigns/');
    expect(text).not.toContain('pending.png');
    expect(text).not.toContain('gone.png');
  });

  test('import validates the chunk and reports that files cannot be restored from a manifest', async () => {
    await attach();
    const exporter = new AttachmentManifestExporter(repository);
    const chunk = await exporter.export(CAMPAIGN);
    expect(await exporter.import(CAMPAIGN, chunk)).toEqual({
      ok: false,
      error: 'attachment_import_unsupported',
    });
    expect(
      await exporter.import(CAMPAIGN, { ...chunk, payload: { entries: [{ objectKey: 'x' }] } }),
    ).toEqual({ ok: false, error: 'attachment_manifest_invalid' });
  });

  test('transaction-aware import: defines the ids, restores nothing, reports the binaries', async () => {
    await attach();
    const exporter = new AttachmentManifestExporter(repository);
    const chunk = await exporter.export(CAMPAIGN);
    const entries = (chunk.payload as { entries: { attachmentId: string }[] }).entries;
    expect(entries.length).toBeGreaterThan(0);
    const before = new Map(repository.rows);
    expect(await exporter.validate(chunk)).toEqual({
      ok: true,
      value: {
        defines: entries.map((entry) => ({ kind: 'attachment', sourceId: entry.attachmentId })),
        warnings: [{ code: 'attachment_binary_not_restored', count: entries.length }],
      },
    });
    const transaction = { brand: 'ImportTransaction' as const };
    expect(
      await exporter.restore(chunk, {
        campaignId: '00000000-0000-4000-8000-0000000000c9',
        importerUserId: ROWAN,
        mapId: () => undefined,
        transaction,
      }),
    ).toEqual({ ok: true, value: { restoredCount: 0, warnings: [] } });
    // No row and no object were written.
    expect(new Map(repository.rows)).toEqual(before);
    expect(await exporter.validate({ ...chunk, payload: { entries: [] } })).toEqual({
      ok: false,
      error: 'attachment_manifest_invalid',
    });
    expect(
      await exporter.validate({ ...chunk, payload: { ...(chunk.payload as object), entries: [] } }),
    ).toEqual({ ok: true, value: { defines: [], warnings: [] } });
  });
});
