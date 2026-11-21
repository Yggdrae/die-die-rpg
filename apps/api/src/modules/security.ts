import { apiError, ErrorCode } from '@rpg/contracts';
import type { FastifyReply, FastifyRequest, HookHandlerDoneFunction } from 'fastify';

export function requireSameOrigin(allowedOrigin: string) {
  return (request: FastifyRequest, reply: FastifyReply, done: HookHandlerDoneFunction): void => {
    const origin = request.headers.origin;
    if (origin === allowedOrigin) {
      done();
      return;
    }
    reply.status(403).send(apiError(ErrorCode.NOT_FOUND_OR_FORBIDDEN, 'Request denied.'));
  };
}

export class FixedWindowRateLimit {
  readonly #requests = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  preHandler(scope: string) {
    return (request: FastifyRequest, reply: FastifyReply, done: HookHandlerDoneFunction): void => {
      const now = Date.now();
      const key = `${scope}:${request.ip}`;
      const current = this.#requests.get(key);
      if (current === undefined || current.resetAt <= now) {
        this.#requests.set(key, { count: 1, resetAt: now + this.windowMs });
        done();
        return;
      }
      if (current.count >= this.limit) {
        reply.status(429).send(apiError(ErrorCode.LIMIT_EXCEEDED, 'Too many requests.'));
        return;
      }
      current.count += 1;
      done();
    };
  }
}
