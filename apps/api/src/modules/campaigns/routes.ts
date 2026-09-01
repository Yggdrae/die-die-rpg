import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import {
  CampaignCreateInput,
  CampaignDeleteInput,
  CampaignDetailsUpdateInput,
  type CampaignService,
  CampaignSettingUpdateInput,
  CampaignSystemUpdateInput,
  CampaignView,
  type SystemCatalog,
  SystemSummary,
} from '@rpg/campaigns';
import { ApiError, apiError, ErrorCode, Id } from '@rpg/contracts';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { requireAuthenticatedUser } from '../identity/authenticate.ts';
import { requireSameOrigin } from '../security.ts';

const CampaignParams = Type.Object({ id: Id }, { additionalProperties: false });
const SettingParams = Type.Object(
  {
    id: Id,
    namespace: Type.String({ minLength: 1, maxLength: 100, pattern: '^[a-z0-9][a-z0-9._-]*$' }),
  },
  { additionalProperties: false },
);
const SystemQuery = Type.Object(
  { query: Type.Optional(Type.String({ maxLength: 200 })) },
  { additionalProperties: false },
);
const SystemUpdateReview = Type.Object(
  {
    current: Type.Object({ systemId: Type.String(), version: Type.String() }),
    target: Type.Optional(Type.Object({ systemId: Type.String(), version: Type.String() })),
  },
  { additionalProperties: false },
);

export function registerCampaignRoutes(
  instance: FastifyInstance,
  services: { readonly campaigns: CampaignService; readonly systems: SystemCatalog },
  options: { readonly allowedOrigin: string },
): void {
  const app = instance.withTypeProvider<TypeBoxTypeProvider>();
  const sameOrigin = requireSameOrigin(options.allowedOrigin);

  app.get(
    '/systems',
    {
      preHandler: requireAuthenticatedUser,
      schema: { querystring: SystemQuery, response: { 200: Type.Array(SystemSummary) } },
    },
    async (request, reply) =>
      reply.status(200).send([...(await services.systems.list(request.query.query))]),
  );

  app.get(
    '/campaigns',
    {
      preHandler: requireAuthenticatedUser,
      schema: { response: { 200: Type.Array(CampaignView) } },
    },
    async (request, reply) => {
      const user = request.authenticatedUser;
      if (user === undefined) return;
      return reply.status(200).send([...(await services.campaigns.list(user.userId))]);
    },
  );

  app.post(
    '/campaigns',
    {
      preHandler: [requireAuthenticatedUser, sameOrigin],
      schema: {
        body: CampaignCreateInput,
        response: { 201: CampaignView, 400: ApiError, 409: ApiError },
      },
    },
    async (request, reply) => {
      const user = request.authenticatedUser;
      if (user === undefined) return;
      const result = await services.campaigns.create(user.userId, request.body);
      return result.ok
        ? reply.status(201).send(result.value)
        : sendCampaignError(reply, result.error);
    },
  );

  app.get(
    '/campaigns/:id',
    {
      preHandler: requireAuthenticatedUser,
      schema: { params: CampaignParams, response: { 200: CampaignView, 404: ApiError } },
    },
    async (request, reply) => {
      const user = request.authenticatedUser;
      if (user === undefined) return;
      const result = await services.campaigns.get(user.userId, request.params.id);
      return result.ok
        ? reply.status(200).send(result.value)
        : sendCampaignError(reply, result.error);
    },
  );

  app.patch(
    '/campaigns/:id',
    {
      preHandler: [requireAuthenticatedUser, sameOrigin],
      schema: {
        params: CampaignParams,
        body: CampaignDetailsUpdateInput,
        response: { 200: CampaignView, 404: ApiError, 409: ApiError },
      },
    },
    async (request, reply) => {
      const user = request.authenticatedUser;
      if (user === undefined) return;
      const result = await services.campaigns.updateDetails(
        user.userId,
        request.params.id,
        request.body,
      );
      return result.ok
        ? reply.status(200).send(result.value)
        : sendCampaignError(reply, result.error);
    },
  );

  app.delete(
    '/campaigns/:id',
    {
      preHandler: [requireAuthenticatedUser, sameOrigin],
      schema: {
        params: CampaignParams,
        body: CampaignDeleteInput,
        response: { 204: Type.Null(), 404: ApiError, 409: ApiError },
      },
    },
    async (request, reply) => {
      const user = request.authenticatedUser;
      if (user === undefined) return;
      const result = await services.campaigns.delete(
        user.userId,
        request.params.id,
        request.body.expectedVersion,
      );
      return result.ok ? reply.status(204).send(null) : sendCampaignError(reply, result.error);
    },
  );

  app.get(
    '/campaigns/:id/system-update',
    {
      preHandler: requireAuthenticatedUser,
      schema: { params: CampaignParams, response: { 200: SystemUpdateReview, 404: ApiError } },
    },
    async (request, reply) => {
      const user = request.authenticatedUser;
      if (user === undefined) return;
      const current = await services.campaigns.get(user.userId, request.params.id);
      if (!current.ok) return sendCampaignError(reply, current.error);
      const target = await services.systems.resolveLatest(current.value.system.systemId);
      return reply.status(200).send({
        current: current.value.system,
        ...(target === undefined || target.summary.ref.version === current.value.system.version
          ? {}
          : { target: target.summary.ref }),
      });
    },
  );

  app.post(
    '/campaigns/:id/system-update',
    {
      preHandler: [requireAuthenticatedUser, sameOrigin],
      schema: {
        params: CampaignParams,
        body: CampaignSystemUpdateInput,
        response: { 200: CampaignView, 400: ApiError, 404: ApiError, 409: ApiError },
      },
    },
    async (request, reply) => {
      const user = request.authenticatedUser;
      if (user === undefined) return;
      const result = await services.campaigns.updateSystem(
        user.userId,
        request.params.id,
        request.body,
      );
      return result.ok
        ? reply.status(200).send(result.value)
        : sendCampaignError(reply, result.error);
    },
  );

  app.put(
    '/campaigns/:id/settings/:namespace',
    {
      preHandler: [requireAuthenticatedUser, sameOrigin],
      schema: {
        params: SettingParams,
        body: CampaignSettingUpdateInput,
        response: { 200: CampaignView, 400: ApiError, 404: ApiError, 409: ApiError },
      },
    },
    async (request, reply) => {
      const user = request.authenticatedUser;
      if (user === undefined) return;
      const result = await services.campaigns.updateSetting(
        user.userId,
        request.params.id,
        request.params.namespace,
        request.body,
      );
      return result.ok
        ? reply.status(200).send(result.value)
        : sendCampaignError(reply, result.error);
    },
  );
}

function sendCampaignError(reply: FastifyReply, error: string) {
  if (error === 'version_conflict' || error === 'campaign_conflict' || error === 'owner_conflict') {
    return reply.status(409).send(apiError(ErrorCode.VERSION_CONFLICT, 'Version conflict.'));
  }
  if (error.startsWith('invalid_') || error === 'system_update_incompatible') {
    return reply.status(400).send(apiError(ErrorCode.VALIDATION_FAILED, 'Request rejected.'));
  }
  return reply.status(404).send(apiError(ErrorCode.NOT_FOUND_OR_FORBIDDEN, 'Not found.'));
}
