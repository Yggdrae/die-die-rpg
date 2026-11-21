import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import {
  AUDIT_PAGE_MAX_LIMIT,
  type AuditQueryResult,
  type AuditQueryService,
  type AuditReadScope,
  type CampaignAuditStoreName,
} from '@rpg/audit';
import { ApiError, apiError, ErrorCode, GM_ONLY, Id, Timestamp } from '@rpg/contracts';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  type ContentAccess,
  type ResourceRouteOptions,
  sendSafeDenial,
} from '../authorization/content-access.ts';
import { inline } from '../authorization/schemas.ts';
import { requireAuthenticatedUser } from '../identity/authenticate.ts';
import type { AuditTargetAccess } from './target-access.ts';

/**
 * Feature 06 task 03 read API (techspec, API):
 *
 * - `GET /campaigns/:campaignId/audit`: campaign store;
 * - `GET /campaigns/:campaignId/sessions/:sessionId/audit`: campaign store, one session;
 * - `GET /campaigns/:campaignId/audit/private`: GM-private store.
 *
 * Each route is bound to one store at registration; no input selects or unions stores. The
 * sanctioned pre-handler decides `read` on the campaign record, so observers, non-members, and
 * deleted campaigns get the safe 404. Every event is then decided on its target's current facts
 * (`AuditTargetAccess`) before rows, totals, cursor, or rendered text exist.
 */

const SafeToken = Type.String({ minLength: 1, maxLength: 64, pattern: '^[a-z][a-z0-9_.-]*$' });

const CampaignParams = inline(Type.Object({ campaignId: Id }, { additionalProperties: false }));
const SessionParams = inline(
  Type.Object({ campaignId: Id, sessionId: Id }, { additionalProperties: false }),
);

const filterFields = {
  cursor: Type.Optional(Id),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: AUDIT_PAGE_MAX_LIMIT })),
  actorId: Type.Optional(Id),
  targetType: Type.Optional(SafeToken),
  targetId: Type.Optional(Id),
};
const AuditFilters = inline(Type.Object(filterFields, { additionalProperties: false }));
const PrivateAuditFilters = inline(
  Type.Object({ ...filterFields, sessionId: Type.Optional(Id) }, { additionalProperties: false }),
);

/** No before/after values and no sequence: only the rendered, already-authorized description. */
export const AuditEntryResponse = inline(
  Type.Object(
    {
      id: Id,
      sessionId: Type.Union([Id, Type.Null()]),
      actor: Type.Object({ userId: Id, role: Type.String() }, { additionalProperties: false }),
      action: Type.String(),
      target: Type.Object({ type: Type.String(), id: Id }, { additionalProperties: false }),
      acceptedAt: Timestamp,
      description: Type.Object(
        {
          kind: Type.Union([Type.Literal('registered'), Type.Literal('generic')]),
          text: Type.String(),
        },
        { additionalProperties: false },
      ),
    },
    { additionalProperties: false },
  ),
);

export const AuditPageResponse = inline(
  Type.Object(
    {
      items: Type.Array(AuditEntryResponse),
      total: Type.Integer({ minimum: 0 }),
      nextCursor: Type.Optional(Id),
    },
    { additionalProperties: false },
  ),
);

const responses = { 200: AuditPageResponse, 400: ApiError, 401: ApiError, 404: ApiError };

export interface AuditRouteServices {
  readonly access: ContentAccess;
  readonly targets: AuditTargetAccess;
  /** Each bound to its own physical store at composition. */
  readonly queries: Readonly<Record<CampaignAuditStoreName, AuditQueryService>>;
}

interface Filters {
  readonly cursor?: string;
  readonly limit?: number;
  readonly actorId?: string;
  readonly targetType?: string;
  readonly targetId?: string;
}

export function registerAuditRoutes(instance: FastifyInstance, services: AuditRouteServices): void {
  const app = instance.withTypeProvider<TypeBoxTypeProvider>();
  // Decided on the campaign record itself: a current member whose role may read the campaign.
  const campaignRead: ResourceRouteOptions = {
    capability: 'read',
    resourceClass: 'campaign',
    resourceId: (request) => (request.params as { campaignId?: unknown }).campaignId,
  };

  app.get(
    '/campaigns/:campaignId/audit',
    {
      config: { contentRoute: true },
      preHandler: [requireAuthenticatedUser, services.access.requireResource(campaignRead)],
      schema: { params: CampaignParams, querystring: AuditFilters, response: responses },
    },
    async (request, reply) =>
      answer(request, reply, services, 'campaign', scopeOf(request.params, request.query)),
  );

  app.get(
    '/campaigns/:campaignId/sessions/:sessionId/audit',
    {
      config: { contentRoute: true },
      preHandler: [requireAuthenticatedUser, services.access.requireResource(campaignRead)],
      schema: { params: SessionParams, querystring: AuditFilters, response: responses },
    },
    async (request, reply) =>
      answer(
        request,
        reply,
        services,
        'campaign',
        scopeOf(request.params, request.query, request.params.sessionId),
      ),
  );

  app.get(
    '/campaigns/:campaignId/audit/private',
    {
      config: { contentRoute: true },
      preHandler: [requireAuthenticatedUser, services.access.requireResource(campaignRead)],
      schema: { params: CampaignParams, querystring: PrivateAuditFilters, response: responses },
    },
    async (request, reply) => {
      // Its own gate: the GM-private store opens only to an Actor who may read this campaign as
      // GM-only content (feature 04 decides; no local role check). Everyone else gets the 404.
      const scoped = request.contentAccess;
      const facts = scoped?.facts;
      if (
        scoped === undefined ||
        facts === undefined ||
        !scoped.decide({ ...facts, visibility: GM_ONLY }).allowed
      ) {
        return sendSafeDenial(reply);
      }
      return answer(
        request,
        reply,
        services,
        'private',
        scopeOf(request.params, request.query, request.query.sessionId),
      );
    },
  );
}

function scopeOf(
  params: { readonly campaignId: string },
  filters: Filters,
  sessionId?: string,
): AuditReadScope {
  return {
    campaignId: params.campaignId,
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(filters.actorId === undefined ? {} : { actorUserId: filters.actorId }),
    ...(filters.targetType === undefined ? {} : { targetType: filters.targetType }),
    ...(filters.targetId === undefined ? {} : { targetId: filters.targetId }),
  };
}

async function answer(
  request: FastifyRequest,
  reply: FastifyReply,
  services: AuditRouteServices,
  store: CampaignAuditStoreName,
  scope: AuditReadScope,
) {
  const actor = request.contentAccess?.actor;
  if (actor === undefined) return sendSafeDenial(reply);
  const filters = request.query as Filters;
  const result: AuditQueryResult = await services.queries[store].query(
    {
      scope,
      ...(filters.limit === undefined ? {} : { limit: filters.limit }),
      ...(filters.cursor === undefined ? {} : { cursor: filters.cursor }),
    },
    services.targets.readerFor(actor, store),
  );
  if (!result.ok) {
    // Hidden, unknown, and out-of-scope cursors are indistinguishable.
    return reply
      .status(400)
      .send(apiError(ErrorCode.VALIDATION_FAILED, 'Request rejected.', { reason: result.reason }));
  }
  return reply.status(200).send(result.page);
}
