import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { ApiError, apiError, ErrorCode, Id } from '@rpg/contracts';
import {
  AccountCreateInput,
  type AccountSessionService,
  AccountSessionView,
  InvitationCreateInput,
  InvitationIssuedView,
  InvitationPreview,
  type InvitationService,
  InvitationView,
  MembershipPage,
  type MembershipService,
  MembershipView,
  OwnershipTransferInput,
  RecoveryConsumeInput,
  type RecoveryService,
  RoleChangeInput,
  SessionCreateInput,
} from '@rpg/identity';
import { type TSchema, Type } from '@sinclair/typebox';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { FixedWindowRateLimit, requireSameOrigin } from '../security.ts';
import { clearSessionCookie, requireAuthenticatedUser, sessionCookie } from './authenticate.ts';

const CampaignParams = inline(Type.Object({ campaignId: Id }, { additionalProperties: false }));
const MemberParams = inline(
  Type.Object({ campaignId: Id, userId: Id }, { additionalProperties: false }),
);
const InvitationParams = inline(
  Type.Object({ campaignId: Id, invitationId: Id }, { additionalProperties: false }),
);
const TokenParams = Type.Object(
  { token: Type.String({ minLength: 43, maxLength: 43 }) },
  { additionalProperties: false },
);

export interface IdentityRouteServices {
  readonly accounts: AccountSessionService;
  readonly recovery: RecoveryService;
  readonly invitations: InvitationService;
  readonly memberships: MembershipService;
}

export interface IdentityRouteOptions {
  readonly allowedOrigin: string;
  readonly secureCookies: boolean;
  readonly rateLimit?: FixedWindowRateLimit;
}

export function registerIdentityRoutes(
  instance: FastifyInstance,
  services: IdentityRouteServices,
  options: IdentityRouteOptions,
): void {
  const app = instance.withTypeProvider<TypeBoxTypeProvider>();
  const rateLimit = options.rateLimit ?? new FixedWindowRateLimit(10, 60_000);
  const sameOrigin = requireSameOrigin(options.allowedOrigin);

  app.post(
    '/auth/accounts',
    {
      preHandler: rateLimit.preHandler('account-create'),
      schema: {
        body: inline(AccountCreateInput),
        response: { 200: inline(AccountSessionView), 400: ApiError, 409: ApiError },
      },
    },
    async (request, reply) => {
      const result = await services.accounts.createAccount(request.body);
      if (!result.ok) return sendIdentityError(reply, result.error);
      reply.header(
        'set-cookie',
        sessionCookie(
          result.value.credential,
          new Date(result.value.view.session.expiresAt),
          options.secureCookies,
        ),
      );
      return reply.status(200).send(result.value.view);
    },
  );

  app.get(
    '/campaigns/:campaignId/invitations',
    {
      preHandler: requireAuthenticatedUser,
      schema: {
        params: CampaignParams,
        response: { 200: inline(Type.Array(InvitationView)), 404: ApiError },
      },
    },
    async (request, reply) => {
      const user = request.authenticatedUser;
      if (user === undefined) return;
      const result = await services.invitations.list(user.userId, request.params.campaignId);
      return result.ok
        ? reply.status(200).send([...result.value])
        : sendIdentityError(reply, result.error);
    },
  );

  app.post(
    '/auth/sessions',
    {
      preHandler: rateLimit.preHandler('login'),
      schema: {
        body: inline(SessionCreateInput),
        response: { 200: inline(AccountSessionView), 401: ApiError },
      },
    },
    async (request, reply) => {
      const result = await services.accounts.login(request.body);
      if (!result.ok) return sendIdentityError(reply, result.error);
      reply.header(
        'set-cookie',
        sessionCookie(
          result.value.credential,
          new Date(result.value.view.session.expiresAt),
          options.secureCookies,
        ),
      );
      return reply.status(200).send(result.value.view);
    },
  );

  app.delete(
    '/auth/session',
    { preHandler: [requireAuthenticatedUser, sameOrigin] },
    async (request, reply) => {
      const user = request.authenticatedUser;
      if (user !== undefined) await services.accounts.logout(user);
      reply.header('set-cookie', clearSessionCookie(options.secureCookies));
      return reply.status(204).send();
    },
  );

  app.post(
    '/auth/recovery/consume',
    {
      preHandler: rateLimit.preHandler('recovery-consume'),
      schema: { body: inline(RecoveryConsumeInput), response: { 204: Type.Null(), 400: ApiError } },
    },
    async (request, reply) => {
      const result = await services.recovery.consume({
        credential: request.body.token,
        newPassword: request.body.newPassword,
      });
      if (!result.ok) return sendIdentityError(reply, result.error);
      return reply.status(204).send(null);
    },
  );

  app.get(
    '/invitations/:token',
    {
      schema: { params: TokenParams, response: { 200: inline(InvitationPreview), 404: ApiError } },
    },
    async (request, reply) => {
      const result = await services.invitations.preview(request.params.token);
      return result.ok
        ? reply.status(200).send(result.value)
        : reply.status(404).send(apiError('unusable_invitation', 'Invitation unavailable.'));
    },
  );

  app.post(
    '/invitations/:token/accept',
    {
      preHandler: [requireAuthenticatedUser, sameOrigin, rateLimit.preHandler('invitation-accept')],
      schema: { params: TokenParams, response: { 200: inline(MembershipView), 404: ApiError } },
    },
    async (request, reply) => {
      const user = request.authenticatedUser;
      if (user === undefined) return;
      const result = await services.invitations.accept(user.userId, request.params.token);
      return result.ok
        ? reply.status(200).send(result.value)
        : sendIdentityError(reply, result.error);
    },
  );

  app.post(
    '/campaigns/:campaignId/invitations',
    {
      preHandler: [requireAuthenticatedUser, sameOrigin],
      schema: {
        params: CampaignParams,
        body: inline(InvitationCreateInput),
        response: { 201: inline(InvitationIssuedView), 400: ApiError, 404: ApiError },
      },
    },
    async (request, reply) => {
      const user = request.authenticatedUser;
      if (user === undefined) return;
      const result = await services.invitations.issue(
        user.userId,
        request.params.campaignId,
        request.body,
      );
      return result.ok
        ? reply.status(201).send(result.value)
        : sendIdentityError(reply, result.error);
    },
  );

  app.delete(
    '/campaigns/:campaignId/invitations/:invitationId',
    {
      preHandler: [requireAuthenticatedUser, sameOrigin],
      schema: { params: InvitationParams, response: { 204: Type.Null(), 404: ApiError } },
    },
    async (request, reply) => {
      const user = request.authenticatedUser;
      if (user === undefined) return;
      const result = await services.invitations.revoke(
        user.userId,
        request.params.campaignId,
        request.params.invitationId,
      );
      return result.ok ? reply.status(204).send(null) : sendIdentityError(reply, result.error);
    },
  );

  app.get(
    '/campaigns/:campaignId/members',
    {
      preHandler: requireAuthenticatedUser,
      schema: { params: CampaignParams, response: { 200: inline(MembershipPage), 404: ApiError } },
    },
    async (request, reply) => {
      const user = request.authenticatedUser;
      if (user === undefined) return;
      const result = await services.memberships.listCampaign(
        user.userId,
        request.params.campaignId,
        {},
      );
      return result.ok
        ? reply.status(200).send(result.value)
        : sendIdentityError(reply, result.error);
    },
  );

  app.get(
    '/users/me/campaigns',
    { preHandler: requireAuthenticatedUser, schema: { response: { 200: inline(MembershipPage) } } },
    async (request, reply) => {
      const user = request.authenticatedUser;
      if (user === undefined) return;
      return reply.status(200).send(await services.memberships.listUser(user.userId, {}));
    },
  );

  app.delete(
    '/campaigns/:campaignId/members/:userId',
    {
      preHandler: [requireAuthenticatedUser, sameOrigin],
      schema: {
        params: MemberParams,
        response: { 204: Type.Null(), 404: ApiError, 409: ApiError },
      },
    },
    async (request, reply) => {
      const user = request.authenticatedUser;
      if (user === undefined) return;
      const result = await services.memberships.remove(
        user.userId,
        request.params.campaignId,
        request.params.userId,
      );
      return result.ok ? reply.status(204).send(null) : sendIdentityError(reply, result.error);
    },
  );

  app.patch(
    '/campaigns/:campaignId/members/:userId/role',
    {
      preHandler: [requireAuthenticatedUser, sameOrigin],
      schema: {
        params: MemberParams,
        body: inline(RoleChangeInput),
        response: { 200: inline(MembershipView), 404: ApiError },
      },
    },
    async (request, reply) => {
      const user = request.authenticatedUser;
      if (user === undefined) return;
      const result = await services.memberships.changeRole(
        user.userId,
        request.params.campaignId,
        request.params.userId,
        request.body.role,
      );
      return result.ok
        ? reply.status(200).send(result.value)
        : sendIdentityError(reply, result.error);
    },
  );

  app.post(
    '/campaigns/:campaignId/ownership-transfer',
    {
      preHandler: [requireAuthenticatedUser, sameOrigin],
      schema: {
        params: CampaignParams,
        body: inline(OwnershipTransferInput),
        response: {
          200: inline(Type.Object({ owner: MembershipView, formerOwner: MembershipView })),
          404: ApiError,
        },
      },
    },
    async (request, reply) => {
      const user = request.authenticatedUser;
      if (user === undefined) return;
      const result = await services.memberships.transferOwnership(
        user.userId,
        request.params.campaignId,
        request.body.targetUserId,
      );
      return result.ok
        ? reply.status(200).send(result.value)
        : sendIdentityError(reply, result.error);
    },
  );
}

function sendIdentityError(reply: FastifyReply, error: string) {
  if (error === 'invalid_credentials') {
    return reply.status(401).send(apiError('invalid_credentials', 'Invalid credentials.'));
  }
  if (error === 'username_taken') {
    return reply.status(409).send(apiError('username_taken', 'Username unavailable.'));
  }
  if (error === 'owner_cannot_be_removed' || error === 'membership_already_exists') {
    return reply.status(409).send(apiError(error, 'Request conflicts with current state.'));
  }
  if (error.startsWith('invalid_')) {
    return reply.status(400).send(apiError(ErrorCode.VALIDATION_FAILED, 'Request rejected.'));
  }
  return reply.status(404).send(apiError(ErrorCode.NOT_FOUND_OR_FORBIDDEN, 'Not found.'));
}

function inline<T extends TSchema>(schema: T): T {
  const cloned = structuredClone(schema);
  removeIds(cloned);
  return cloned;
}

function removeIds(value: unknown): void {
  if (typeof value !== 'object' || value === null) return;
  if (Array.isArray(value)) {
    for (const item of value) removeIds(item);
    return;
  }
  const record = value as Record<string, unknown>;
  delete record.$id;
  for (const child of Object.values(record)) removeIds(child);
}
