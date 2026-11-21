import { beforeEach, describe, expect, test } from 'bun:test';
import type { CampaignAuditSubmission } from '@rpg/audit';
import type { Visibility } from '@rpg/contracts';
import { AttachmentService, type FinalizeRejection, type UploadRejection } from './application.ts';
import { AttachmentCleanup } from './cleanup.ts';
import { MemoryAttachmentRepository, MemoryObjectStorage } from './memory.ts';
import type { AttachmentUploadRequest } from './model.ts';
import { MAX_ATTACHMENT_BYTES } from './policy.ts';
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

const NPC = ownerId(1);
const HIDDEN_NPC = ownerId(2);
const CASEY_SECRET = ownerId(3);
const FOREIGN_NPC = ownerId(4);
const EVERYONE: Visibility = { mode: 'everyone' };

let clock: Date;
let repository: MemoryAttachmentRepository;
let storage: MemoryObjectStorage;
let authorizer: FixtureAuthorizer;
let audit: CampaignAuditSubmission[];
let storageLog: string[];
let service: AttachmentService;
let ids: number;

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
    maxActivePending: 3,
    log: { storageUnavailable: (operation) => storageLog.push(operation) },
    now: () => clock,
    newId: () => `00000000-0000-4000-8000-${(0x9000 + ids++).toString(16).padStart(12, '0')}`,
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
  authorizer.putOwner(NOTE, FOREIGN_NPC, EVERYONE, { campaignId: OTHER_CAMPAIGN });
  audit = [];
  storageLog = [];
  ids = 0;
  build();
});

function request(overrides: Partial<AttachmentUploadRequest> = {}): AttachmentUploadRequest {
  const bytes = fileBytes(overrides.mime ?? 'image/png');
  return {
    owner: { resourceClass: NOTE, resourceId: NPC },
    filename: 'harbor-map.png',
    mime: 'image/png',
    size: bytes.byteLength,
    checksum: sha256(bytes),
    visibility: EVERYONE,
    ...overrides,
  };
}

/** Requests permission, "uploads" the bytes to the granted key, and finalizes. */
async function attach(
  overrides: Partial<AttachmentUploadRequest> = {},
  actor = GM,
  bytes = fileBytes(overrides.mime ?? 'image/png'),
) {
  const body = request({ size: bytes.byteLength, checksum: sha256(bytes), ...overrides });
  const permission = await service.requestUpload(actor, CAMPAIGN, body);
  if (!permission.ok) throw new Error(permission.error);
  const id = permission.value.attachment.attachmentId;
  const row = repository.rows.get(id);
  if (row === undefined) throw new Error('no pending row');
  storage.put(row.objectKey, bytes, body.mime);
  return { id, body, permission: permission.value, row };
}

describe('upload permission (FR-003, FR-004)', () => {
  // Scenario Outline: A GM attaches a supported file to a supported entity.
  for (const entity of ['NPC', 'location', 'note']) {
    test(`a GM attaches a file to a ${entity}`, async () => {
      const owner = ownerId(100 + entity.length);
      authorizer.putOwner(NOTE, owner, { mode: 'gm_only' });
      const { id } = await attach({ owner: { resourceClass: NOTE, resourceId: owner } });
      const ready = await service.finalize(GM, CAMPAIGN, id, request());
      expect(ready.ok).toBe(true);
      const listed = await service.list(GM, CAMPAIGN, { resourceClass: NOTE, resourceId: owner });
      expect(listed.ok && listed.value.map((item) => item.attachmentId)).toEqual([id]);
      const resolved = await service.resolve(GM, CAMPAIGN, id);
      expect(resolved.ok && resolved.value).toMatchObject({
        filename: 'harbor-map.png',
        mime: 'image/png',
        size: 64,
        checksum: sha256(fileBytes('image/png')),
        visibility: EVERYONE,
        createdBy: GM,
        updatedBy: GM,
        status: 'ready',
        version: 1,
      });
    });
  }

  test('issues one bound PUT grant with a ten-minute lifetime and no file bytes', async () => {
    const result = await service.requestUpload(GM, CAMPAIGN, request());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.upload.method).toBe('PUT');
    expect(result.value.upload.headers).toEqual({ 'content-type': 'image/png' });
    expect(Date.parse(result.value.upload.expiresAt) - clock.getTime()).toBe(600_000);
    expect(Date.parse(result.value.attachment.expiresAt) - clock.getTime()).toBe(86_400_000);
    expect(result.value.attachment.status).toBe('pending');
    expect(JSON.stringify(result.value)).not.toContain('campaigns/');
    expect(storage.grants).toHaveLength(1);
    expect(repository.rows.size).toBe(1);
  });

  // Scenario: Upload permission requires an authorization decision.
  test('fails closed when no authorization decision is available', async () => {
    authorizer.unavailable = true;
    let failed = false;
    try {
      await service.requestUpload(GM, CAMPAIGN, request());
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
    expect(storage.grants).toHaveLength(0);
    expect(repository.rows.size).toBe(0);
  });

  // Scenario Outline: An unauthorized actor receives no upload destination.
  const denied: [string, () => Promise<unknown>][] = [
    [
      'a player cannot update the target entity',
      () => service.requestUpload(CASEY, CAMPAIGN, request()),
    ],
    ['an observer', () => service.requestUpload(OBSERVER, CAMPAIGN, request())],
    [
      'the actor is not a member of the target campaign',
      () => service.requestUpload(STRANGER, CAMPAIGN, request()),
    ],
    [
      'the target entity belongs to another campaign',
      () =>
        service.requestUpload(
          GM,
          CAMPAIGN,
          request({ owner: { resourceClass: NOTE, resourceId: FOREIGN_NPC } }),
        ),
    ],
    [
      'the target entity does not exist',
      () =>
        service.requestUpload(
          GM,
          CAMPAIGN,
          request({ owner: { resourceClass: NOTE, resourceId: ownerId(77) } }),
        ),
    ],
    [
      'the resource class is unknown',
      () =>
        service.requestUpload(
          GM,
          CAMPAIGN,
          request({ owner: { resourceClass: 'npc', resourceId: NPC } }),
        ),
    ],
    [
      'a registered class that does not accept attachments',
      () => {
        build([SECRET]);
        return service.requestUpload(GM, CAMPAIGN, request());
      },
    ],
    [
      "a GM role on another author's private record",
      () =>
        service.requestUpload(
          GM,
          CAMPAIGN,
          request({ owner: { resourceClass: SECRET, resourceId: CASEY_SECRET } }),
        ),
    ],
    ['a malformed campaign identifier', () => service.requestUpload(GM, 'not-a-uuid', request())],
  ];
  for (const [condition, run] of denied) {
    test(`denied without revealing existence: ${condition}`, async () => {
      expect(await run()).toEqual({ ok: false, error: 'not_found' });
      expect(storage.grants).toHaveLength(0);
      expect(repository.rows.size).toBe(0);
    });
  }

  test('a player may attach to their own author-private record', async () => {
    const result = await service.requestUpload(
      CASEY,
      CAMPAIGN,
      request({ owner: { resourceClass: SECRET, resourceId: CASEY_SECRET } }),
    );
    expect(result.ok).toBe(true);
  });

  test('the policy runs after the decision: an outsider learns nothing about the file policy', async () => {
    const oversized = request({ mime: 'video/mp4', size: MAX_ATTACHMENT_BYTES * 2 });
    expect(await service.requestUpload(STRANGER, CAMPAIGN, oversized)).toEqual({
      ok: false,
      error: 'not_found',
    });
    expect(await service.requestUpload(GM, CAMPAIGN, oversized)).toEqual({
      ok: false,
      error: 'unsupported_file_type',
    });
  });

  // Scenario: Client acceptance cannot bypass server validation.
  test('server validation is independent of the client', async () => {
    const cases: [Partial<AttachmentUploadRequest>, UploadRejection][] = [
      [{ size: MAX_ATTACHMENT_BYTES + 1 }, 'file_too_large'],
      [{ mime: 'image/svg+xml' }, 'unsupported_file_type'],
      [{ mime: 'text/html' }, 'unsupported_file_type'],
      [{ filename: '../../etc/passwd' }, 'invalid_filename'],
      [{ checksum: 'zz' }, 'invalid_checksum'],
      [{ size: 0 }, 'empty_file'],
    ];
    for (const [overrides, error] of cases) {
      expect(await service.requestUpload(GM, CAMPAIGN, request(overrides))).toEqual({
        ok: false,
        error,
      });
    }
    expect(
      await service.requestUpload(GM, CAMPAIGN, request({ size: MAX_ATTACHMENT_BYTES })),
    ).toMatchObject({
      ok: true,
    });
    expect(storage.grants).toHaveLength(1);
  });

  test('visibility: unknown shapes, party targets and non-member targets are rejected', async () => {
    const cases: [unknown, UploadRejection][] = [
      [{ mode: 'secret' }, 'invalid_visibility'],
      [{ mode: 'players', playerIds: [] }, 'invalid_visibility'],
      [{ mode: 'party', partyIds: [NPC] }, 'target_mode_not_allowed'],
      [{ mode: 'players', playerIds: [STRANGER] }, 'target_not_member'],
    ];
    for (const [visibility, error] of cases) {
      expect(
        await service.requestUpload(
          GM,
          CAMPAIGN,
          request({ visibility: visibility as Visibility }),
        ),
      ).toEqual({ ok: false, error });
    }
    const targeted = await service.requestUpload(
      GM,
      CAMPAIGN,
      request({ visibility: { mode: 'players', playerIds: [ROWAN, CASEY, CASEY] } }),
    );
    expect(targeted.ok).toBe(true);
    if (!targeted.ok) return;
    expect(repository.rows.get(targeted.value.attachment.attachmentId)?.visibility).toEqual({
      mode: 'players',
      playerIds: [CASEY, ROWAN],
    });
  });

  test('unexpired pending uploads are capped per actor and campaign', async () => {
    for (let index = 0; index < 3; index += 1) {
      expect((await service.requestUpload(GM, CAMPAIGN, request())).ok).toBe(true);
    }
    expect(await service.requestUpload(GM, CAMPAIGN, request())).toEqual({
      ok: false,
      error: 'limit_exceeded',
    });
    clock = new Date(clock.getTime() + 24 * 3_600_000 + 1);
    expect((await service.requestUpload(GM, CAMPAIGN, request())).ok).toBe(true);
  });

  test('a provider fault gives no grant and leaves only a collectable pending row', async () => {
    storage.failing.add('upload');
    expect(await service.requestUpload(GM, CAMPAIGN, request())).toEqual({
      ok: false,
      error: 'storage_unavailable',
    });
    expect(storageLog).toEqual(['upload_grant']);
    expect([...repository.rows.values()].map((row) => row.status)).toEqual(['pending']);
  });
});

describe('verified finalization (FR-005)', () => {
  // Scenario: An upload is not visible before finalization.
  test('a pending upload is absent and gets no read URL', async () => {
    const { id } = await attach();
    expect(await service.list(GM, CAMPAIGN, { resourceClass: NOTE, resourceId: NPC })).toEqual({
      ok: true,
      value: [],
    });
    expect(await service.resolve(GM, CAMPAIGN, id)).toEqual({ ok: false, error: 'not_found' });
    expect(await service.issueRead(GM, CAMPAIGN, id)).toEqual({ ok: false, error: 'not_found' });
    expect(storage.grants.filter((grant) => grant.method === 'GET')).toHaveLength(0);
  });

  // Scenario: A valid finalization makes one attachment visible.
  test('verifies size, SHA-256 and signature, then makes exactly one attachment ready', async () => {
    const { id, body } = await attach();
    const result = await service.finalize(GM, CAMPAIGN, id, {
      size: body.size,
      checksum: body.checksum,
    });
    expect(result.ok && result.value.status).toBe('ready');
    const listed = await service.list(CASEY, CAMPAIGN, { resourceClass: NOTE, resourceId: NPC });
    expect(listed.ok && listed.value.map((item) => item.attachmentId)).toEqual([id]);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      originMutationId: id,
      targetVisibility: { visibility: EVERYONE },
      event: {
        campaignId: CAMPAIGN,
        actor: { userId: GM, campaignId: CAMPAIGN, role: 'gm' },
        action: 'attachment.uploaded',
        targetType: NOTE,
        targetId: NPC,
        after: { mime: 'image/png', size: 64 },
        private: false,
      },
    });
    expect(JSON.stringify(audit[0])).not.toContain('harbor-map');
  });

  // Scenario: Retrying finalization is idempotent.
  test('repeating finalization with the same values returns the same attachment', async () => {
    const { id, body } = await attach();
    const first = await service.finalize(GM, CAMPAIGN, id, body);
    const second = await service.finalize(GM, CAMPAIGN, id, body);
    expect(second).toEqual(first);
    expect(repository.rows.size).toBe(1);
    expect(audit).toHaveLength(1);
    const listed = await service.list(GM, CAMPAIGN, { resourceClass: NOTE, resourceId: NPC });
    expect(listed.ok && listed.value).toHaveLength(1);
  });

  test('a mismatched retry after success changes nothing', async () => {
    const { id, body } = await attach();
    await service.finalize(GM, CAMPAIGN, id, body);
    const before = structuredClone(repository.rows.get(id));
    expect(await service.finalize(GM, CAMPAIGN, id, { ...body, size: body.size + 1 })).toEqual({
      ok: false,
      error: 'size_mismatch',
    });
    expect(await service.finalize(GM, CAMPAIGN, id, { ...body, checksum: 'b'.repeat(64) })).toEqual(
      {
        ok: false,
        error: 'checksum_mismatch',
      },
    );
    expect(repository.rows.get(id)).toEqual(before);
  });

  // Scenario Outline: A stored-file mismatch prevents finalization.
  const stored: [string, (bytes: Uint8Array) => Uint8Array, FinalizeRejection][] = [
    ['size', (bytes) => new Uint8Array([...bytes, 0]), 'size_mismatch'],
    [
      'checksum',
      (bytes) => bytes.map((value, index) => (index === 40 ? value ^ 1 : value)),
      'checksum_mismatch',
    ],
  ];
  for (const [property, tamper, error] of stored) {
    test(`a stored ${property} mismatch fails the upload`, async () => {
      const bytes = fileBytes('image/png');
      const { id, body, row } = await attach({}, GM, bytes);
      storage.put(row.objectKey, tamper(bytes));
      expect(await service.finalize(GM, CAMPAIGN, id, body)).toEqual({ ok: false, error });
      expect(repository.rows.get(id)?.status).toBe('failed');
      expect(storage.objects.has(row.objectKey)).toBe(false);
      expect(await service.list(GM, CAMPAIGN, { resourceClass: NOTE, resourceId: NPC })).toEqual({
        ok: true,
        value: [],
      });
      expect(await service.issueRead(GM, CAMPAIGN, id)).toEqual({ ok: false, error: 'not_found' });
      // A failed upload never becomes ready, even with matching bytes later.
      storage.put(row.objectKey, bytes);
      expect(await service.finalize(GM, CAMPAIGN, id, body)).toEqual({
        ok: false,
        error: 'upload_failed',
      });
      expect(audit).toHaveLength(0);
    });
  }

  test('content whose signature is not the declared type fails (HTML labelled PNG)', async () => {
    const html = new TextEncoder().encode('<html><script>parent.steal()</script></html>');
    const { id, body } = await attach({}, GM, html);
    expect(await service.finalize(GM, CAMPAIGN, id, body)).toEqual({
      ok: false,
      error: 'signature_mismatch',
    });
    expect(repository.rows.get(id)?.status).toBe('failed');
  });

  test('submitted values that differ from the declaration change nothing', async () => {
    const { id, body } = await attach();
    expect(await service.finalize(GM, CAMPAIGN, id, { ...body, size: 65 })).toEqual({
      ok: false,
      error: 'size_mismatch',
    });
    expect(repository.rows.get(id)?.status).toBe('pending');
    expect((await service.finalize(GM, CAMPAIGN, id, body)).ok).toBe(true);
  });

  test('finalizing before the bytes arrive reports incomplete and stays pending', async () => {
    const permission = await service.requestUpload(GM, CAMPAIGN, request());
    if (!permission.ok) throw new Error(permission.error);
    const id = permission.value.attachment.attachmentId;
    expect(await service.finalize(GM, CAMPAIGN, id, request())).toEqual({
      ok: false,
      error: 'upload_incomplete',
    });
    expect(repository.rows.get(id)?.status).toBe('pending');
  });

  test('only the uploader, still allowed to update the owner, may finalize', async () => {
    const { id, body } = await attach();
    authorizer.members.roles.set(`${CAMPAIGN}:${ROWAN}`, 'gm');
    expect(await service.finalize(ROWAN, CAMPAIGN, id, body)).toEqual({
      ok: false,
      error: 'not_found',
    });
    expect(await service.finalize(GM, OTHER_CAMPAIGN, id, body)).toEqual({
      ok: false,
      error: 'not_found',
    });
    authorizer.members.roles.set(`${CAMPAIGN}:${GM}`, 'player');
    expect(await service.finalize(GM, CAMPAIGN, id, body)).toEqual({
      ok: false,
      error: 'not_found',
    });
    expect(repository.rows.get(id)?.status).toBe('pending');
  });

  test('an upload past its 24-hour lifetime cannot be finalized', async () => {
    const { id, body } = await attach();
    clock = new Date(clock.getTime() + 24 * 3_600_000);
    // Exactly at the boundary is still valid (exclusive comparison)...
    expect((await repository.find(CAMPAIGN, id))?.pendingExpired).toBe(false);
    clock = new Date(clock.getTime() + 1);
    expect(await service.finalize(GM, CAMPAIGN, id, body)).toEqual({
      ok: false,
      error: 'upload_expired',
    });
  });

  test('a provider fault during verification leaves the upload retryable', async () => {
    const { id, body } = await attach();
    storage.failing.add('read');
    expect(await service.finalize(GM, CAMPAIGN, id, body)).toEqual({
      ok: false,
      error: 'storage_unavailable',
    });
    expect(repository.rows.get(id)?.status).toBe('pending');
    storage.failing.clear();
    expect((await service.finalize(GM, CAMPAIGN, id, body)).ok).toBe(true);
  });

  test('each operation asks feature 04 again (no cached decision)', async () => {
    const { id, body } = await attach();
    await service.finalize(GM, CAMPAIGN, id, body);
    authorizer.requests.length = 0;
    await service.issueRead(GM, CAMPAIGN, id);
    await service.issueRead(GM, CAMPAIGN, id);
    expect(authorizer.requests).toEqual([
      { capability: 'read', resourceId: NPC },
      { capability: 'read', resourceId: NPC },
    ]);
  });
});

describe('authorized reads (FR-007)', () => {
  async function ready(overrides: Partial<AttachmentUploadRequest> = {}, mime = 'image/png') {
    const { id, body } = await attach({ mime, ...overrides }, GM, fileBytes(mime));
    const result = await service.finalize(GM, CAMPAIGN, id, body);
    if (!result.ok) throw new Error(result.error);
    return id;
  }

  test('an authorized viewer receives a five-minute read grant with the declared type', async () => {
    const id = await ready({}, 'application/pdf');
    const grant = await service.issueRead(CASEY, CAMPAIGN, id);
    expect(grant.ok && grant.value).toMatchObject({
      attachmentId: id,
      method: 'GET',
      mime: 'application/pdf',
      disposition: 'inline',
    });
    expect(grant.ok && Date.parse(grant.value.expiresAt) - clock.getTime()).toBe(300_000);
  });

  // Scenario: A hidden attachment does not leak through resolution.
  test('hidden and missing attachments are indistinguishable', async () => {
    const gmOnly = await ready({ visibility: { mode: 'gm_only' } });
    const onHiddenOwner = await ready({ owner: { resourceClass: NOTE, resourceId: HIDDEN_NPC } });
    const forRowan = await ready({ visibility: { mode: 'players', playerIds: [ROWAN] } });
    const missing = '00000000-0000-4000-8000-00000000dead';
    const answers = await Promise.all(
      [gmOnly, onHiddenOwner, forRowan, missing].map((id) =>
        service.issueRead(CASEY, CAMPAIGN, id),
      ),
    );
    for (const answer of answers) expect(answer).toEqual({ ok: false, error: 'not_found' });
    expect((await service.issueRead(ROWAN, CAMPAIGN, forRowan)).ok).toBe(true);
    for (const id of [gmOnly, onHiddenOwner, forRowan]) {
      expect((await service.issueRead(GM, CAMPAIGN, id)).ok).toBe(true);
    }
    for (const outsider of [OBSERVER, STRANGER]) {
      expect(await service.issueRead(outsider, CAMPAIGN, forRowan)).toEqual({
        ok: false,
        error: 'not_found',
      });
    }
    expect(await service.issueRead(GM, OTHER_CAMPAIGN, gmOnly)).toEqual({
      ok: false,
      error: 'not_found',
    });
  });

  test('lists hold only what the Actor may read; a hidden owner lists as not found', async () => {
    const shared = await ready();
    const gmOnly = await ready({ visibility: { mode: 'gm_only' } });
    const owner = { resourceClass: NOTE, resourceId: NPC };
    const gm = await service.list(GM, CAMPAIGN, owner);
    const casey = await service.list(CASEY, CAMPAIGN, owner);
    expect(gm.ok && gm.value.map((item) => item.attachmentId)).toEqual([shared, gmOnly]);
    expect(casey.ok && casey.value.map((item) => item.attachmentId)).toEqual([shared]);
    expect(JSON.stringify(casey)).not.toContain(gmOnly);
    expect(
      await service.list(CASEY, CAMPAIGN, { resourceClass: NOTE, resourceId: HIDDEN_NPC }),
    ).toEqual(
      await service.list(CASEY, CAMPAIGN, { resourceClass: NOTE, resourceId: ownerId(99) }),
    );
    expect(await service.list(STRANGER, CAMPAIGN, owner)).toEqual({
      ok: false,
      error: 'not_found',
    });
  });

  test('an attachment cannot widen its owner', async () => {
    const id = await ready({
      owner: { resourceClass: NOTE, resourceId: HIDDEN_NPC },
      visibility: EVERYONE,
    });
    expect(await service.resolve(CASEY, CAMPAIGN, id)).toEqual({ ok: false, error: 'not_found' });
  });

  test('narrowing the attachment or its owner denies the next grant', async () => {
    const id = await ready();
    expect((await service.issueRead(CASEY, CAMPAIGN, id)).ok).toBe(true);
    repository.setVisibility(id, { mode: 'gm_only' });
    expect(await service.issueRead(CASEY, CAMPAIGN, id)).toEqual({ ok: false, error: 'not_found' });
    repository.setVisibility(id, EVERYONE);
    authorizer.putOwner(NOTE, NPC, { mode: 'gm_only' });
    expect(await service.issueRead(CASEY, CAMPAIGN, id)).toEqual({ ok: false, error: 'not_found' });
  });

  test('membership revocation denies renewal', async () => {
    const id = await ready();
    expect((await service.issueRead(CASEY, CAMPAIGN, id)).ok).toBe(true);
    authorizer.members.revoke(CAMPAIGN, CASEY);
    expect(await service.issueRead(CASEY, CAMPAIGN, id)).toEqual({ ok: false, error: 'not_found' });
  });

  test('a tombstoned attachment gets no new read URL', async () => {
    const id = await ready();
    repository.tombstone(id);
    expect(await service.issueRead(GM, CAMPAIGN, id)).toEqual({ ok: false, error: 'not_found' });
    expect(await service.list(GM, CAMPAIGN, { resourceClass: NOTE, resourceId: NPC })).toEqual({
      ok: true,
      value: [],
    });
  });

  test('a read request with no decision available fails closed', async () => {
    const id = await ready();
    const before = storage.grants.length;
    authorizer.unavailable = true;
    let failed = false;
    try {
      await service.issueRead(GM, CAMPAIGN, id);
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
    expect(storage.grants).toHaveLength(before);
  });

  test('a download grant carries the filename only for an allowed actor', async () => {
    const id = await ready({ filename: 'Secret NPC.pdf' }, 'application/pdf');
    const grant = await service.issueRead(GM, CAMPAIGN, id, 'attachment');
    expect(grant.ok && grant.value.disposition).toBe('attachment');
    expect(
      await service.issueRead(
        CASEY,
        CAMPAIGN,
        '00000000-0000-4000-8000-00000000beef',
        'attachment',
      ),
    ).toEqual({
      ok: false,
      error: 'not_found',
    });
  });
});

describe('abandoned upload collection', () => {
  // Scenario: An abandoned upload is collected.
  test('after 24 hours the bytes go and the upload stays absent; metadata goes after 7 days', async () => {
    const { id, row } = await attach();
    const keep = await attach();
    const cleanup = new AttachmentCleanup({ repository, storage });
    clock = new Date(clock.getTime() + 24 * 3_600_000);
    expect(await cleanup.run()).toEqual({ expired: 0, purged: 0, storageFailures: 0 });
    await service.finalize(GM, CAMPAIGN, keep.id, keep.body);
    clock = new Date(clock.getTime() + 1);
    expect(await cleanup.run()).toEqual({ expired: 1, purged: 0, storageFailures: 0 });
    expect(storage.objects.has(row.objectKey)).toBe(false);
    expect(repository.rows.get(id)?.status).toBe('failed');
    expect(await service.issueRead(GM, CAMPAIGN, id)).toEqual({ ok: false, error: 'not_found' });
    clock = new Date(clock.getTime() + 7 * 86_400_000);
    expect(await cleanup.run()).toEqual({ expired: 0, purged: 1, storageFailures: 0 });
    expect(repository.rows.has(id)).toBe(false);
    // The finalized attachment is never collected.
    expect(repository.rows.get(keep.id)?.status).toBe('ready');
    expect(storage.objects.has(keep.row.objectKey)).toBe(true);
  });

  test('a provider fault keeps the row for the next pass', async () => {
    const { id } = await attach();
    const cleanup = new AttachmentCleanup({ repository, storage });
    clock = new Date(clock.getTime() + 25 * 3_600_000);
    storage.failing.add('delete');
    expect(await cleanup.run()).toEqual({ expired: 0, purged: 0, storageFailures: 1 });
    expect(repository.rows.get(id)?.status).toBe('pending');
    storage.failing.clear();
    expect(await cleanup.run()).toEqual({ expired: 1, purged: 0, storageFailures: 0 });
  });
});
