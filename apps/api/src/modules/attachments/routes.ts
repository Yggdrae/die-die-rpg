import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import {
  ATTACHMENT_MIME_TYPES,
  AttachmentFinalizeRequest,
  AttachmentList,
  AttachmentMetadata,
  AttachmentReadGrant,
  type AttachmentService,
  AttachmentUploadPermission,
  AttachmentUploadRequest,
  type FinalizeRejection,
  MAX_ATTACHMENT_BYTES,
  type UploadRejection,
} from '@rpg/attachments';
import { ApiError, apiError, ErrorCode, Id } from '@rpg/contracts';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { type ContentAccess, sendSafeDenial } from '../authorization/content-access.ts';
import { inline } from '../authorization/schemas.ts';
import { requireAuthenticatedUser } from '../identity/authenticate.ts';
import { requireSameOrigin } from '../security.ts';

/**
 * Feature 05 attachment routes (techspec, API). Thin TypeBox boundaries over `AttachmentService`,
 * which obtains a fresh feature 04 decision on the owning record for every call. Hidden and
 * missing attachments answer with the same safe 404 as an unmatched route. Responses carrying a
 * signed URL are `no-store`; no URL, object key or filename is ever logged.
 */

export interface AttachmentRouteServices {
  readonly attachments: AttachmentService;
  readonly access: ContentAccess;
}

const CampaignParams = inline(Type.Object({ campaignId: Id }, { additionalProperties: false }));
const AttachmentParams = inline(
  Type.Object({ campaignId: Id, attachmentId: Id }, { additionalProperties: false }),
);
const OwnerParams = inline(
  Type.Object(
    { campaignId: Id, class: Type.String({ minLength: 1, maxLength: 100 }), resourceId: Id },
    { additionalProperties: false },
  ),
);
const ReadQuery = Type.Object(
  {
    disposition: Type.Optional(Type.Union([Type.Literal('inline'), Type.Literal('attachment')])),
  },
  { additionalProperties: false },
);
const FinalizeResponse = inline(
  Type.Object({ attachment: AttachmentMetadata }, { additionalProperties: false }),
);
const Errors = { 400: ApiError, 404: ApiError, 409: ApiError, 503: ApiError };
const OfflineSet = inline(
  Type.Object(
    { items: Type.Array(AttachmentMetadata), totalBytes: Type.Integer({ minimum: 0 }) },
    { additionalProperties: false },
  ),
);
const DeleteQuery = Type.Object(
  { expectedVersion: Type.Integer({ minimum: 1 }) },
  { additionalProperties: false },
);
const DeleteResponse = inline(
  Type.Object(
    { attachmentId: Id, version: Type.Integer({ minimum: 1 }), deletedAt: Type.String() },
    { additionalProperties: false },
  ),
);

export function registerAttachmentRoutes(
  instance: FastifyInstance,
  services: AttachmentRouteServices,
  options: { readonly allowedOrigin: string },
): void {
  const app = instance.withTypeProvider<TypeBoxTypeProvider>();
  const sameOrigin = requireSameOrigin(options.allowedOrigin);

  app.post(
    '/campaigns/:campaignId/attachments/uploads',
    {
      preHandler: [requireAuthenticatedUser, sameOrigin],
      schema: {
        params: CampaignParams,
        body: inline(AttachmentUploadRequest),
        response: {
          201: inline(AttachmentUploadPermission),
          ...Errors,
          413: ApiError,
          415: ApiError,
          429: ApiError,
        },
      },
    },
    async (request, reply) => {
      const user = request.authenticatedUser;
      if (user === undefined) return;
      const result = await services.attachments.requestUpload(
        user.userId,
        request.params.campaignId,
        request.body,
      );
      if (!result.ok) return sendUploadRejection(reply, result.error);
      return reply.header('cache-control', 'no-store').status(201).send(result.value);
    },
  );

  app.post(
    '/campaigns/:campaignId/attachments/:attachmentId/finalize',
    {
      preHandler: [requireAuthenticatedUser, sameOrigin],
      schema: {
        params: AttachmentParams,
        body: inline(AttachmentFinalizeRequest),
        response: { 200: FinalizeResponse, ...Errors, 422: ApiError },
      },
    },
    async (request, reply) => {
      const user = request.authenticatedUser;
      if (user === undefined) return;
      const { campaignId, attachmentId } = request.params;
      const result = await services.attachments.finalize(
        user.userId,
        campaignId,
        attachmentId,
        request.body,
      );
      if (!result.ok) return sendFinalizeRejection(reply, result.error);
      return reply.status(200).send({ attachment: result.value });
    },
  );

  app.get(
    '/campaigns/:campaignId/resources/:class/:resourceId/attachments',
    {
      preHandler: [
        requireAuthenticatedUser,
        // First decision on the owner; the service repeats it and narrows per attachment.
        services.access.requireResource({
          capability: 'read',
          resourceClass: (request) => (request.params as { class: string }).class,
        }),
      ],
      schema: {
        params: OwnerParams,
        response: { 200: inline(AttachmentList), 404: ApiError },
      },
    },
    async (request, reply) => {
      const user = request.authenticatedUser;
      if (user === undefined) return;
      const { campaignId, class: resourceClass, resourceId } = request.params;
      const result = await services.attachments.list(user.userId, campaignId, {
        resourceClass,
        resourceId,
      });
      if (!result.ok) return sendSafeDenial(reply);
      return reply.status(200).send({ items: result.value });
    },
  );

  // Task 05: the campaign's offline set (every attachment the Actor may read, with verified size
  // and checksum) for the device's estimate. Each owner gets a fresh decision; non-members 404.
  app.get(
    '/campaigns/:campaignId/attachments/offline-estimate',
    {
      preHandler: [requireAuthenticatedUser],
      schema: { params: CampaignParams, response: { 200: OfflineSet, 404: ApiError } },
    },
    async (request, reply) => {
      const user = request.authenticatedUser;
      if (user === undefined) return;
      const result = await services.attachments.listCampaign(
        user.userId,
        request.params.campaignId,
      );
      if (!result.ok) return sendSafeDenial(reply);
      return reply
        .header('cache-control', 'no-store')
        .status(200)
        .send({
          items: result.value,
          totalBytes: result.value.reduce((sum, item) => sum + item.size, 0),
        });
    },
  );

  // Task 06: versioned tombstone. Bytes are not removed inline; new read URLs are denied at once.
  app.delete(
    '/campaigns/:campaignId/attachments/:attachmentId',
    {
      preHandler: [requireAuthenticatedUser, sameOrigin],
      schema: {
        params: AttachmentParams,
        querystring: DeleteQuery,
        response: { 200: DeleteResponse, 400: ApiError, 404: ApiError, 409: ApiError },
      },
    },
    async (request, reply) => {
      const user = request.authenticatedUser;
      if (user === undefined) return;
      const { campaignId, attachmentId } = request.params;
      const result = await services.attachments.delete(
        user.userId,
        campaignId,
        attachmentId,
        request.query.expectedVersion,
      );
      if (!result.ok) {
        return result.error === 'not_found'
          ? sendSafeDenial(reply)
          : reply
              .status(409)
              .send(apiError(ErrorCode.VERSION_CONFLICT, 'The attachment changed. Reload it.'));
      }
      return reply.status(200).send(result.value);
    },
  );

  app.get(
    '/campaigns/:campaignId/attachments/:attachmentId/read',
    {
      preHandler: [requireAuthenticatedUser],
      schema: {
        params: AttachmentParams,
        querystring: ReadQuery,
        response: { 200: inline(AttachmentReadGrant), 404: ApiError, 503: ApiError },
      },
    },
    async (request, reply) => {
      const user = request.authenticatedUser;
      if (user === undefined) return;
      const { campaignId, attachmentId } = request.params;
      const result = await services.attachments.issueRead(
        user.userId,
        campaignId,
        attachmentId,
        request.query.disposition ?? 'inline',
      );
      if (!result.ok) {
        return result.error === 'not_found' ? sendSafeDenial(reply) : sendUnavailable(reply);
      }
      return reply.header('cache-control', 'no-store').status(200).send(result.value);
    },
  );
}

function sendUnavailable(reply: FastifyReply) {
  return reply
    .status(503)
    .send(apiError('storage_unavailable', 'File storage is unavailable. Try again shortly.'));
}

function sendUploadRejection(reply: FastifyReply, rejection: UploadRejection) {
  switch (rejection) {
    case 'not_found':
      return sendSafeDenial(reply);
    case 'unsupported_file_type':
      return reply.status(415).send(
        apiError('unsupported_file_type', 'Only PDF, JPEG, PNG and WebP files can be attached.', {
          allowed: [...ATTACHMENT_MIME_TYPES],
        }),
      );
    case 'file_too_large':
      return reply.status(413).send(
        apiError('file_too_large', 'Files are limited to 25 MB.', {
          maxBytes: MAX_ATTACHMENT_BYTES,
        }),
      );
    case 'limit_exceeded':
      return reply
        .status(429)
        .send(apiError(ErrorCode.LIMIT_EXCEEDED, 'Too many unfinished uploads. Finish or wait.'));
    case 'storage_unavailable':
      return sendUnavailable(reply);
    default:
      return reply.status(400).send(
        apiError(ErrorCode.VALIDATION_FAILED, 'The file cannot be attached.', {
          reason: rejection,
        }),
      );
  }
}

const MISMATCH_MESSAGES: Readonly<Record<string, string>> = {
  size_mismatch: 'The uploaded file size does not match.',
  checksum_mismatch: 'The uploaded file checksum does not match.',
  signature_mismatch: 'The uploaded file is not the declared type.',
};

const LIFECYCLE_MESSAGES: Readonly<Record<string, string>> = {
  upload_incomplete: 'The file has not finished uploading.',
  upload_expired: 'The upload expired. Start a new upload.',
  upload_failed: 'The upload failed verification. Start a new upload.',
};

function sendFinalizeRejection(reply: FastifyReply, rejection: FinalizeRejection) {
  if (rejection === 'not_found') return sendSafeDenial(reply);
  if (rejection === 'storage_unavailable') return sendUnavailable(reply);
  const mismatch = MISMATCH_MESSAGES[rejection];
  if (mismatch !== undefined) return reply.status(422).send(apiError(rejection, mismatch));
  return reply
    .status(409)
    .send(apiError(rejection, LIFECYCLE_MESSAGES[rejection] ?? 'The upload cannot be finalized.'));
}
