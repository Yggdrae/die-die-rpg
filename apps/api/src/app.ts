import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { type ApiError, apiError, ErrorCode } from '@rpg/contracts';
import { Type } from '@sinclair/typebox';
import Fastify, { type FastifyError, type FastifyInstance, type FastifyRequest } from 'fastify';

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
  /** `true` logs to stdout; a stream captures log lines (tests). */
  readonly logger?: boolean | { readonly stream: { write(line: string): void } };
}

/** Invitation tokens travel in the path; request logs must never carry them. */
export function redactCredentialPath(url: string): string {
  return url.replace(/^\/invitations\/[^/?#]+/, '/invitations/[redacted]');
}

const requestLogSerializers = {
  req(request: FastifyRequest) {
    return {
      method: request.method,
      url: redactCredentialPath(request.url),
      host: request.host,
      remoteAddress: request.ip,
      remotePort: request.socket?.remotePort,
    };
  },
};

export function buildApp(options: BuildOptions = {}): FastifyInstance {
  const app = Fastify({
    logger:
      options.logger === undefined || options.logger === false
        ? false
        : {
            serializers: requestLogSerializers,
            ...(options.logger === true ? {} : { stream: options.logger.stream }),
          },
    ajv: { customOptions: { removeAdditional: false } },
  }).withTypeProvider<TypeBoxTypeProvider>();

  app.addHook('onSend', async (_request, reply) => {
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    reply.header('Cross-Origin-Embedder-Policy', 'require-corp');
  });

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

    // Fastify's own request rejections (body too large, unsupported media type, malformed body)
    // are client errors: keep their status with a fixed safe code, never their message.
    const status = error.statusCode;
    if (error.code?.startsWith('FST_') && status !== undefined && status >= 400 && status < 500) {
      const code =
        status === 413
          ? 'payload_too_large'
          : status === 415
            ? 'unsupported_media_type'
            : 'bad_request';
      return reply.status(status).send(apiError(code, 'Request rejected.'));
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
