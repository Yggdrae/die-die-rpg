import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { type ActorRef, ApiError, apiError, ErrorCode } from '@rpg/contracts';
import {
  type AuditWatermarkScope,
  type AuthorityMutationService,
  CampaignParams,
  type CurrentAccessResolver,
  HoldAcquireResponse,
  HoldFieldBody,
  HoldMutationBody,
  LongTextHoldSchema,
  type LongTextHoldService,
  MutationBatchResponse,
  MutationBatchSchema,
  ReplicaAcknowledgementBody,
  SyncBootstrapQuery,
  SyncBootstrapResponse,
  type SyncBootstrapService,
} from '@rpg/sync';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ContentAccess } from '../authorization/content-access.ts';
import { requireAuthenticatedUser } from '../identity/authenticate.ts';
import { requireSameOrigin } from '../security.ts';

export interface SyncWatermarkRecorder {
  acknowledge(input: {
    readonly campaignId: string;
    readonly userId: string;
    readonly replicaId: string;
    readonly tableName: string;
    readonly sequence: number;
    readonly pendingRecordIds?: readonly string[];
  }): Promise<void>;
  replicaDropped(input: {
    readonly campaignId: string;
    readonly userId: string;
    readonly replicaId: string;
  }): Promise<void>;
}

/**
 * Feature 06 retention follow-up: resolves a replica's audit acknowledgement (an event ID it holds)
 * to that event's sequence, only when the event is in the campaign's store and `actor` may read
 * it now; anything else is `undefined`.
 */
export interface SyncAuditAcknowledgements {
  resolve(
    actor: ActorRef,
    tableName: AuditWatermarkScope,
    eventId: string,
  ): Promise<number | undefined>;
}

export function registerSyncRoutes(
  instance: FastifyInstance,
  services: {
    readonly access: CurrentAccessResolver;
    readonly bootstrap: SyncBootstrapService;
    readonly mutations: AuthorityMutationService;
    readonly holds: LongTextHoldService;
    /** Feature 04 decision for the held record; a hold needs `update` on it. */
    readonly records: Pick<ContentAccess, 'authorizeResource'>;
    readonly watermarks: SyncWatermarkRecorder;
    /** Absent: audit acknowledgements are accepted and ignored (no audit stores composed). */
    readonly auditAcknowledgements?: SyncAuditAcknowledgements;
  },
  options: { readonly allowedOrigin: string },
): void {
  const app = instance.withTypeProvider<TypeBoxTypeProvider>();
  const sameOrigin = requireSameOrigin(options.allowedOrigin);

  app.get(
    '/sync/bootstrap/:campaignId',
    {
      preHandler: requireAuthenticatedUser,
      schema: {
        params: CampaignParams,
        querystring: SyncBootstrapQuery,
        response: { 200: SyncBootstrapResponse, 404: ApiError },
      },
    },
    async (request, reply) => {
      const user = request.authenticatedUser;
      if (user === undefined) return;
      const bootstrap = await services.bootstrap.bootstrap(
        user.userId,
        request.params.campaignId,
        request.query.replicaId,
      );
      return bootstrap === undefined ? hidden(reply) : reply.status(200).send(bootstrap);
    },
  );

  app.post(
    '/sync/mutations',
    {
      preHandler: [requireAuthenticatedUser, sameOrigin],
      schema: {
        body: MutationBatchSchema,
        response: { 200: MutationBatchResponse, 400: ApiError },
      },
    },
    async (request, reply) => {
      const user = request.authenticatedUser;
      if (user === undefined) return;
      // B-2: the authenticated session (never the payload) reaches the appliers for holds.
      const outcomes = await services.mutations.apply(user.userId, request.body, {
        sessionId: user.sessionId,
      });
      return reply.status(200).send({ outcomes: [...outcomes] });
    },
  );

  app.post(
    '/sync/replicas/:campaignId/ack',
    {
      preHandler: [requireAuthenticatedUser, sameOrigin],
      schema: {
        params: CampaignParams,
        body: ReplicaAcknowledgementBody,
        response: { 204: Type.Null(), 400: ApiError, 404: ApiError },
      },
    },
    async (request, reply) => {
      const user = request.authenticatedUser;
      if (user === undefined) return;
      const actor = await services.access.resolve(user.userId, request.params.campaignId);
      if (actor === undefined) return hidden(reply);
      const body = request.body;
      if ('throughEventId' in body) {
        // Audit stores: the device names an event it holds; the sequence is resolved here and
        // never returned. An unresolvable event answers the same 204 and records nothing.
        const sequence = await services.auditAcknowledgements?.resolve(
          actor,
          body.tableName,
          body.throughEventId,
        );
        if (sequence !== undefined) {
          await services.watermarks.acknowledge({
            campaignId: request.params.campaignId,
            userId: user.userId,
            replicaId: body.replicaId,
            tableName: body.tableName,
            sequence,
          });
        }
        return reply.status(204).send(null);
      }
      await services.watermarks.acknowledge({
        campaignId: request.params.campaignId,
        userId: user.userId,
        ...body,
      });
      return reply.status(204).send(null);
    },
  );

  app.delete(
    '/sync/replicas/:campaignId',
    {
      preHandler: [requireAuthenticatedUser, sameOrigin],
      schema: {
        params: CampaignParams,
        body: Type.Object({
          replicaId: Type.String({
            pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
          }),
        }),
        response: { 204: Type.Null() },
      },
    },
    async (request, reply) => {
      const user = request.authenticatedUser;
      if (user === undefined) return;
      await services.watermarks.replicaDropped({
        campaignId: request.params.campaignId,
        userId: user.userId,
        replicaId: request.body.replicaId,
      });
      return reply.status(204).send(null);
    },
  );

  // Unknown, hidden, missing and denied records answer like a non-member campaign, so a hold
  // (and its holder) is never disclosed for a record the caller cannot edit.
  const mayHold = async (
    userId: string,
    campaignId: string,
    field: { readonly resourceClass: string; readonly recordId: string },
  ) =>
    (
      await services.records.authorizeResource(userId, {
        campaignId,
        resourceClass: field.resourceClass,
        resourceId: field.recordId,
        capability: 'update',
      })
    ).allowed;

  for (const action of ['acquire', 'takeover'] as const) {
    app.post(
      `/sync/holds/:campaignId/${action}`,
      {
        preHandler: [requireAuthenticatedUser, sameOrigin],
        schema: {
          params: CampaignParams,
          body: HoldFieldBody,
          response: { 200: HoldAcquireResponse, 404: ApiError },
        },
      },
      async (request, reply) => {
        const user = request.authenticatedUser;
        if (user === undefined) return;
        if (!(await mayHold(user.userId, request.params.campaignId, request.body))) {
          return hidden(reply);
        }
        const field = { campaignId: request.params.campaignId, ...request.body };
        const holder = { userId: user.userId, sessionId: user.sessionId };
        const result =
          action === 'acquire'
            ? await services.holds.acquire(field, holder)
            : await services.holds.takeover(field, holder);
        return 'heldBy' in result
          ? reply.status(200).send({ acquired: false, ...result })
          : reply.status(200).send({ acquired: true, hold: result });
      },
    );
  }

  app.post(
    '/sync/holds/:campaignId/renew',
    {
      preHandler: [requireAuthenticatedUser, sameOrigin],
      schema: {
        params: CampaignParams,
        body: HoldMutationBody,
        response: { 200: LongTextHoldSchema, 404: ApiError, 409: ApiError },
      },
    },
    async (request, reply) => {
      const user = request.authenticatedUser;
      if (user === undefined) return;
      if (!(await mayHold(user.userId, request.params.campaignId, request.body))) {
        return hidden(reply);
      }
      const { expectedVersion, ...fieldBody } = request.body;
      const hold = await services.holds.renew({
        field: { campaignId: request.params.campaignId, ...fieldBody },
        holderSessionId: user.sessionId,
        expectedVersion,
      });
      return hold === undefined
        ? conflict(reply, 'Long-text hold changed.')
        : reply.status(200).send(hold);
    },
  );

  app.post(
    '/sync/holds/:campaignId/release',
    {
      preHandler: [requireAuthenticatedUser, sameOrigin],
      schema: {
        params: CampaignParams,
        body: HoldMutationBody,
        response: { 204: Type.Null(), 404: ApiError, 409: ApiError },
      },
    },
    async (request, reply) => {
      const user = request.authenticatedUser;
      if (user === undefined) return;
      if (!(await mayHold(user.userId, request.params.campaignId, request.body))) {
        return hidden(reply);
      }
      const { expectedVersion, ...fieldBody } = request.body;
      const released = await services.holds.release({
        field: { campaignId: request.params.campaignId, ...fieldBody },
        holderSessionId: user.sessionId,
        expectedVersion,
      });
      return released ? reply.status(204).send(null) : conflict(reply, 'Long-text hold changed.');
    },
  );
}

function hidden(reply: FastifyReply) {
  return reply.status(404).send(apiError(ErrorCode.NOT_FOUND_OR_FORBIDDEN, 'Not found.'));
}

function conflict(reply: FastifyReply, message: string) {
  return reply.status(409).send(apiError(ErrorCode.VERSION_CONFLICT, message));
}
