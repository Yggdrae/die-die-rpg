import {
  type AttachmentRepository,
  AttachmentService,
  type AttachmentUploadRequest,
  MemoryAttachmentRepository,
  MemoryObjectStorage,
  type ObjectStorage,
} from '@rpg/attachments';
import type { CampaignAuditSubmission } from '@rpg/audit';
import { AuthorizationService } from '@rpg/authorization';
import type { Visibility } from '@rpg/contracts';
import { buildApp } from '../../app.ts';
import { ContentAccess, type ContentDenialReason } from '../authorization/content-access.ts';
import {
  CAMPAIGN,
  CREDENTIALS,
  fixtureContext,
  NOTE,
  ORIGIN,
  SECRET,
} from '../authorization/test-fixture.ts';
import { registerIdentityAuthentication } from '../identity/authenticate.ts';
import { contentAccessAttachmentAuthorizer } from './authorizer.ts';
import { registerAttachmentRoutes } from './routes.ts';

/**
 * Test-only composition: the feature 04 fixture classes (`fixture_note`, author-private
 * `fixture_secret`) as attachment owners, the real `ContentAccess` and `AuthorizationService`,
 * and swappable storage/repository. No production content class exists yet.
 */

export function attachmentApp(
  options: {
    readonly storage?: ObjectStorage;
    readonly repository?: AttachmentRepository;
    readonly logLines?: string[];
  } = {},
) {
  const context = fixtureContext();
  const denials: [string, ContentDenialReason][] = [];
  const access = new ContentAccess({
    registry: context.registry,
    actors: context.members,
    onDenied: (resourceClass, reason) => denials.push([resourceClass, reason]),
  });
  const storage = options.storage ?? new MemoryObjectStorage();
  const repository = options.repository ?? new MemoryAttachmentRepository();
  const audit: CampaignAuditSubmission[] = [];
  const attachments = new AttachmentService({
    repository,
    storage,
    authorizer: contentAccessAttachmentAuthorizer(
      access,
      new AuthorizationService(context.registry),
    ),
    members: context.members,
    audit: {
      recordCampaign: async (submission) => {
        audit.push(submission);
        return 'recorded';
      },
    },
    ownerClasses: [NOTE, SECRET],
  });
  const app = buildApp(
    options.logLines === undefined
      ? {}
      : { logger: { stream: { write: (line: string) => options.logLines?.push(line) } } },
  );
  const byCredential = new Map(
    Object.entries(CREDENTIALS).map(([userId, value]) => [value, userId]),
  );
  registerIdentityAuthentication(app, {
    authenticate: async (credential) => {
      const userId = byCredential.get(credential);
      return userId === undefined
        ? undefined
        : { userId, sessionId: '00000000-0000-4000-8000-000000000999' };
    },
  });
  access.install(app);
  // Every route the attachment module registers (task 07 inventory: none may serve anonymously).
  const routes: { method: string; url: string }[] = [];
  app.addHook('onRoute', (route) => {
    for (const method of [route.method].flat()) {
      if (method !== 'HEAD') routes.push({ method, url: route.url });
    }
  });
  registerAttachmentRoutes(app, { attachments, access }, { allowedOrigin: ORIGIN });
  return { app, context, access, attachments, storage, repository, audit, denials, routes };
}

export function headersFor(userId: string | undefined): Record<string, string> {
  return userId === undefined
    ? { origin: ORIGIN }
    : { origin: ORIGIN, cookie: `rpg_session=${CREDENTIALS[userId]}` };
}

export function uploadBody(
  bytes: Uint8Array,
  overrides: Partial<AttachmentUploadRequest> & { visibility?: Visibility } = {},
): AttachmentUploadRequest {
  return {
    owner: { resourceClass: NOTE, resourceId: '00000000-0000-4000-8000-000000001001' },
    filename: 'harbor-map.png',
    mime: 'image/png',
    size: bytes.byteLength,
    checksum: new Bun.CryptoHasher('sha256').update(bytes).digest('hex'),
    visibility: { mode: 'everyone' },
    ...overrides,
  };
}

export const PNG = (() => {
  const bytes = new Uint8Array(96);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  for (let index = 16; index < bytes.length; index += 1) bytes[index] = index;
  return bytes;
})();

export const PDF = (() => {
  const text =
    '%PDF-1.7\n1 0 obj << /Type /Catalog /OpenAction << /S /JavaScript /JS (app.alert(1)) >> >> endobj\n%%EOF\n';
  return new TextEncoder().encode(text);
})();

export { CAMPAIGN };
