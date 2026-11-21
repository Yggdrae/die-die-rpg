import { Readable } from 'node:stream';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import {
  ContributorSummary,
  type ImportService,
  type OnlineExportService,
  PACKAGE_LIMITS,
} from '@rpg/campaign-portability';
import { ApiError, apiError, Id } from '@rpg/contracts';
import { Type } from '@sinclair/typebox';
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  HookHandlerDoneFunction,
} from 'fastify';
import { type ContentAccess, sendSafeDenial } from '../authorization/content-access.ts';
import { inline } from '../authorization/schemas.ts';
import { requireAuthenticatedUser } from '../identity/authenticate.ts';
import { requireSameOrigin } from '../security.ts';

/**
 * Feature 07 task 04: online export routes (`_techspec.md`, API). Every route is a content route
 * for the `campaign` class with the `export` capability, decided by feature 04 through
 * `ContentAccess.requireResource`: only a current `owner` or `gm` passes, on every call, so a GM
 * demoted after generating a file can no longer download it. A miss and a denial answer the same
 * safe 404. Job status and the file are additionally scoped to the requesting user.
 *
 * Responses never carry a URL, an object key, or package content; the file streams from a
 * short-lived in-process holding area and leaves the server once delivered or expired.
 */

export interface PortabilityRouteServices {
  readonly exports: OnlineExportService;
  /** Feature 07 task 06. Without it no import route is registered. */
  readonly imports?: ImportService;
  readonly access: ContentAccess;
  /** Safe display identity of the exporting user (never an email or credential). */
  readonly displayName: (userId: string) => Promise<string>;
}

const CampaignParams = Type.Object({ campaignId: Id }, { additionalProperties: false });
const JobParams = Type.Object({ jobId: Id }, { additionalProperties: false });
const StartBody = Type.Object(
  {
    /** Client-generated; a retry with the same id returns the same job and never regenerates. */
    jobId: Id,
    /** The GM-secret warning was shown and accepted (`_bdd.md`, A GM exports one campaign). */
    acknowledgeGmSecrets: Type.Literal(true),
  },
  { additionalProperties: false },
);
const JobView = inline(
  Type.Object(
    {
      jobId: Id,
      campaignId: Id,
      state: Type.Union([
        Type.Literal('requested'),
        Type.Literal('running'),
        Type.Literal('completed'),
        Type.Literal('failed'),
      ]),
      summary: Type.Array(ContributorSummary),
      errorCode: Type.Optional(Type.String()),
      createdAt: Type.String(),
      completedAt: Type.Optional(Type.String()),
      fileAvailableUntil: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
  ),
);

const Pin = Type.Object(
  {
    systemId: Type.Optional(Type.String()),
    moduleId: Type.Optional(Type.String()),
    version: Type.String(),
  },
  { additionalProperties: false },
);
const ImportWarningView = Type.Object(
  {
    code: Type.String(),
    sourceId: Type.Optional(Type.String()),
    count: Type.Optional(Type.Integer()),
  },
  { additionalProperties: false },
);
const ImportJobView = inline(
  Type.Object(
    {
      jobId: Id,
      state: Type.Union([
        Type.Literal('running'),
        Type.Literal('completed'),
        Type.Literal('failed'),
      ]),
      campaignId: Type.Optional(Id),
      report: Type.Object(
        {
          modules: Type.Array(
            Type.Object(
              {
                moduleId: Type.String(),
                chunkVersion: Type.String(),
                outcome: Type.Union([Type.Literal('restored'), Type.Literal('preserved')]),
                restoredCount: Type.Integer({ minimum: 0 }),
                warnings: Type.Array(ImportWarningView),
              },
              { additionalProperties: false },
            ),
          ),
        },
        { additionalProperties: false },
      ),
      errorCode: Type.Optional(Type.String()),
      failure: Type.Optional(
        Type.Object(
          {
            moduleId: Type.Optional(Type.String()),
            path: Type.Optional(Type.String()),
            detail: Type.Optional(Type.String()),
            unavailable: Type.Optional(
              Type.Object(
                { system: Type.Optional(Pin), modules: Type.Optional(Type.Array(Pin)) },
                { additionalProperties: false },
              ),
            ),
          },
          { additionalProperties: false },
        ),
      ),
      createdAt: Type.String(),
      completedAt: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
  ),
);
const PACKAGE_TYPES = ['application/zip', 'application/octet-stream'];

declare module 'fastify' {
  interface FastifyRequest {
    exportJobCampaignId: string | undefined;
  }
}

export function registerPortabilityRoutes(
  instance: FastifyInstance,
  services: PortabilityRouteServices,
  options: { readonly allowedOrigin: string },
): void {
  const app = instance.withTypeProvider<TypeBoxTypeProvider>();
  app.decorateRequest('exportJobCampaignId', undefined);
  const sameOrigin = requireSameOrigin(options.allowedOrigin);
  const routeCampaign = (request: FastifyRequest) =>
    (request.params as { campaignId?: unknown }).campaignId;
  const jobCampaign = (request: FastifyRequest) => request.exportJobCampaignId;
  // Resolves the job's campaign for the requesting user only; anything else is the safe 404
  // before the authorization decision runs.
  const loadOwnJob = (
    request: FastifyRequest,
    reply: FastifyReply,
    done: HookHandlerDoneFunction,
  ) => {
    const user = request.authenticatedUser;
    const { jobId } = request.params as { jobId: string };
    if (user === undefined) {
      done();
      return;
    }
    services.exports.job(jobId).then(
      (job) => {
        if (job === undefined || job.requestedBy !== user.userId) {
          sendSafeDenial(reply);
          return;
        }
        request.exportJobCampaignId = job.campaignId;
        done();
      },
      (error: unknown) => done(error instanceof Error ? error : new Error(String(error))),
    );
  };

  app.post(
    '/campaigns/:campaignId/exports',
    {
      config: { contentRoute: true },
      preHandler: [
        requireAuthenticatedUser,
        sameOrigin,
        services.access.requireResource({
          capability: 'export',
          resourceClass: 'campaign',
          campaignId: routeCampaign,
          resourceId: routeCampaign,
        }),
      ],
      schema: {
        params: CampaignParams,
        body: StartBody,
        response: { 201: JobView, 400: ApiError, 403: ApiError, 404: ApiError },
      },
    },
    async (request, reply) => {
      const user = request.authenticatedUser;
      if (user === undefined) return;
      const started = await services.exports.start({
        jobId: request.body.jobId,
        campaignId: request.params.campaignId,
        userId: user.userId,
        displayName: await services.displayName(user.userId),
      });
      if (!started.ok) return sendSafeDenial(reply);
      return reply.header('cache-control', 'no-store').status(201).send(started.value);
    },
  );

  app.get(
    '/exports/:jobId',
    {
      config: { contentRoute: true },
      preHandler: [
        requireAuthenticatedUser,
        loadOwnJob,
        services.access.requireResource({
          capability: 'export',
          resourceClass: 'campaign',
          campaignId: jobCampaign,
          resourceId: jobCampaign,
        }),
      ],
      schema: { params: JobParams, response: { 200: JobView, 404: ApiError } },
    },
    async (request, reply) => {
      const user = request.authenticatedUser;
      if (user === undefined) return;
      const view = await services.exports.status(request.params.jobId, user.userId);
      if (view === undefined) return sendSafeDenial(reply);
      return reply.header('cache-control', 'no-store').status(200).send(view);
    },
  );

  app.get(
    '/exports/:jobId/file',
    {
      config: { contentRoute: true },
      preHandler: [
        requireAuthenticatedUser,
        loadOwnJob,
        services.access.requireResource({
          capability: 'export',
          resourceClass: 'campaign',
          campaignId: jobCampaign,
          resourceId: jobCampaign,
        }),
      ],
      schema: {
        params: JobParams,
        response: { 200: Type.Unknown(), 404: ApiError, 410: ApiError },
      },
    },
    async (request, reply) => {
      const user = request.authenticatedUser;
      if (user === undefined) return;
      const { jobId } = request.params;
      const file = services.exports.file(jobId, user.userId);
      if (file === undefined) {
        return reply
          .status(410)
          .send(apiError('export_file_unavailable', 'The export file is no longer available.'));
      }
      // Bytes leave the server once the response completed.
      reply.raw.once('finish', () => services.exports.delivered(jobId));
      return reply
        .header('cache-control', 'no-store')
        .header('content-type', 'application/zip')
        .header('content-length', String(file.size))
        .header('content-disposition', `attachment; filename="campaign-${jobId}.rpgpack"`)
        .header('x-content-type-options', 'nosniff')
        .status(200)
        .send(
          Readable.from(
            file.parts.map((part) => Buffer.from(part.buffer, part.byteOffset, part.byteLength)),
          ),
        );
    },
  );

  const imports = services.imports;
  if (imports === undefined) return;
  /**
   * Feature 07 task 06: atomic import (`_techspec.md`, API; inspect and commit in one request for
   * P0, so package bytes never outlive the request). Any authenticated user may import, like
   * creating a campaign; the new campaign's sole owner is that user, and every later access to it
   * goes through feature 04. These are not campaign-content routes: no campaign exists before
   * the commit, and the job is scoped to the requesting user. Package bytes are parsed only here.
   */
  instance.register(async (scope) => {
    scope.addContentTypeParser(
      PACKAGE_TYPES,
      { parseAs: 'buffer', bodyLimit: PACKAGE_LIMITS.maxPackageBytes },
      (_request, body, done) => done(null, body),
    );
    const typed = scope.withTypeProvider<TypeBoxTypeProvider>();
    typed.post(
      '/imports/:jobId',
      {
        bodyLimit: PACKAGE_LIMITS.maxPackageBytes,
        preHandler: [requireAuthenticatedUser, sameOrigin],
        schema: {
          params: JobParams,
          response: { 201: ImportJobView, 400: ApiError, 403: ApiError, 404: ApiError },
        },
      },
      async (request, reply) => {
        const user = request.authenticatedUser;
        if (user === undefined) return;
        const body = request.body;
        if (!(body instanceof Uint8Array) || body.length === 0) {
          return reply
            .status(400)
            .send(apiError('import_package_required', 'Send the .rpgpack file as the body.'));
        }
        const started = await imports.start({
          jobId: request.params.jobId,
          userId: user.userId,
          bytes: new Uint8Array(body.buffer, body.byteOffset, body.byteLength),
        });
        if (!started.ok) return sendSafeDenial(reply);
        return reply.header('cache-control', 'no-store').status(201).send(started.value);
      },
    );
    typed.get(
      '/imports/:jobId',
      {
        preHandler: requireAuthenticatedUser,
        schema: { params: JobParams, response: { 200: ImportJobView, 404: ApiError } },
      },
      async (request, reply) => {
        const user = request.authenticatedUser;
        if (user === undefined) return;
        const view = await imports.status(request.params.jobId, user.userId);
        if (view === undefined) return sendSafeDenial(reply);
        return reply.header('cache-control', 'no-store').status(200).send(view);
      },
    );
  });
}
