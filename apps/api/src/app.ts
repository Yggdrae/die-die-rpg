import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { type ApiError, apiError, ErrorCode } from '@rpg/contracts';
import { Type } from '@sinclair/typebox';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';

/**
 * Fastify shell. No domain routes, no authentication, no persistence.
 *
 * Feature 01 adds the first real route and the authentication boundary. What this file
 * establishes is the two things every later route inherits: TypeBox schemas at the
 * boundary, and one error shape that never leaks internal detail
 * (`docs/SPEC_GUIDELINE.md`, API and Validation).
 */

const HealthResponse = Type.Object({
  status: Type.Literal('ok'),
  version: Type.String(),
});

export interface BuildOptions {
  readonly version?: string;
  readonly logger?: boolean;
}

export function buildApp(options: BuildOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: options.logger ?? false,
  }).withTypeProvider<TypeBoxTypeProvider>();

  /**
   * One error shape for every failure. Validation issues are surfaced structurally;
   * anything unexpected is reported without its internal message, since an error body is
   * a place internal detail escapes by default.
   */
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error.validation !== undefined) {
      const body: ApiError = apiError(
        ErrorCode.VALIDATION_FAILED,
        'Request failed schema validation.',
        {
          issues: error.validation.map((issue: { instancePath?: string; message?: string }) => ({
            path: issue.instancePath ?? '',
            message: issue.message ?? 'invalid',
          })),
        },
      );
      return reply.status(400).send(body);
    }

    request.log.error({ err: error }, 'unhandled error');
    const body: ApiError = apiError('internal_error', 'Something went wrong.');
    return reply.status(500).send(body);
  });

  /**
   * A miss and a denial must be indistinguishable, so a client cannot probe for the
   * existence of hidden content (feature 04 FR-009).
   */
  app.setNotFoundHandler((_request, reply) => {
    const body: ApiError = apiError(ErrorCode.NOT_FOUND_OR_FORBIDDEN, 'Not found.');
    return reply.status(404).send(body);
  });

  app.get('/health', { schema: { response: { 200: HealthResponse } } }, async () => ({
    status: 'ok' as const,
    version: options.version ?? '0.0.0',
  }));

  return app;
}
