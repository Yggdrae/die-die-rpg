import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import {
  MAX_VISIBILITY_TARGETS,
  normalizeVisibility,
  type VisibilityChangeResult,
  type VisibilityService,
} from '@rpg/authorization';
import { ApiError, apiError, ErrorCode, Id, Version, Visibility } from '@rpg/contracts';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { requireAuthenticatedUser } from '../identity/authenticate.ts';
import { requireSameOrigin } from '../security.ts';
import { type ContentAccess, sendSafeDenial } from './content-access.ts';
import { inline } from './schemas.ts';

/** `PATCH /campaigns/:campaignId/resources/:class/:resourceId/visibility` (techspec, API). */

const VisibilityParams = inline(
  Type.Object(
    {
      campaignId: Id,
      class: Type.String({ minLength: 1, maxLength: 100 }),
      resourceId: Id,
    },
    { additionalProperties: false },
  ),
);

const TargetIdList = Type.Array(inline(Id), { minItems: 1, maxItems: MAX_VISIBILITY_TARGETS });

/** No actor, role, user or campaign field: the Actor is the authenticated session's membership. */
export const VisibilityChangeBody = inline(
  Type.Object(
    {
      operation: Type.Union([Type.Literal('reveal'), Type.Literal('unreveal')]),
      target: Type.Union([
        Type.Object({ mode: Type.Literal('everyone') }, { additionalProperties: false }),
        Type.Object(
          { mode: Type.Literal('players'), playerIds: TargetIdList },
          { additionalProperties: false },
        ),
        Type.Object(
          { mode: Type.Literal('party'), partyIds: TargetIdList },
          { additionalProperties: false },
        ),
      ]),
      expectedVersion: Version,
    },
    { additionalProperties: false },
  ),
);

export const VisibilityChangeView = inline(
  Type.Object(
    {
      resourceClass: Type.String(),
      resourceId: Id,
      visibility: Visibility,
      version: Version,
      /** `false` for a no-op (duplicate reveal): no write, no version bump, no audit. */
      changed: Type.Boolean(),
    },
    { additionalProperties: false },
  ),
);

export interface VisibilityRouteServices {
  readonly access: ContentAccess;
  readonly visibility: VisibilityService;
}

export function registerVisibilityRoutes(
  instance: FastifyInstance,
  services: VisibilityRouteServices,
  options: { readonly allowedOrigin: string },
): void {
  const app = instance.withTypeProvider<TypeBoxTypeProvider>();
  const sameOrigin = requireSameOrigin(options.allowedOrigin);

  app.patch(
    '/campaigns/:campaignId/resources/:class/:resourceId/visibility',
    {
      preHandler: [
        requireAuthenticatedUser,
        sameOrigin,
        // First decision, from the authoritative Actor. `VisibilityService.change` repeats it.
        services.access.requireResource({
          capability: 'reveal',
          resourceClass: (request) => (request.params as { class: string }).class,
        }),
      ],
      schema: {
        params: VisibilityParams,
        body: VisibilityChangeBody,
        response: { 200: VisibilityChangeView, 400: ApiError, 404: ApiError, 409: ApiError },
      },
    },
    async (request, reply) => {
      const user = request.authenticatedUser;
      if (user === undefined) return;
      const { campaignId, class: resourceClass, resourceId } = request.params;
      const result = await services.visibility.change(user.userId, {
        campaignId,
        resourceClass,
        resourceId,
        operation: request.body.operation,
        target: request.body.target,
        expectedVersion: request.body.expectedVersion,
      });
      return sendVisibilityResult(reply, result, resourceClass, resourceId);
    },
  );
}

function sendVisibilityResult(
  reply: FastifyReply,
  result: VisibilityChangeResult,
  resourceClass: string,
  resourceId: string,
) {
  switch (result.status) {
    case 'changed':
    case 'unchanged':
      return reply.status(200).send({
        resourceClass,
        resourceId,
        visibility: normalizeVisibility(result.facts.visibility),
        version: result.facts.version,
        changed: result.status === 'changed',
      });
    case 'conflict':
      // Reachable only after the `reveal` decision allowed, so it discloses nothing new.
      return reply.status(409).send(apiError(ErrorCode.VERSION_CONFLICT, 'Version conflict.'));
    case 'rejected':
      switch (result.reason) {
        case 'target_mode_not_allowed':
        case 'party_unresolved':
        case 'target_not_member':
        case 'incompatible_visibility':
          // Reachable only by an actor already allowed to reveal this record.
          return reply
            .status(400)
            .send(
              apiError(ErrorCode.VALIDATION_FAILED, 'Request rejected.', { reason: result.reason }),
            );
        case 'invalid_change':
        case 'actor_not_member':
        case 'unknown_resource_class':
        case 'not_found':
        case 'denied':
          // Existence matters: identical to a miss.
          return sendSafeDenial(reply);
        default:
          return assertNever(result.reason);
      }
    default:
      return assertNever(result);
  }
}

function assertNever(value: never): never {
  throw new Error(`unhandled_visibility_result: ${JSON.stringify(value)}`);
}
