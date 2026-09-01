import { type ApiError, apiError, ErrorCode } from '@rpg/contracts';
import type { AuthenticatedUser } from '@rpg/identity';
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  HookHandlerDoneFunction,
} from 'fastify';

export const SESSION_COOKIE_NAME = 'rpg_session';

declare module 'fastify' {
  interface FastifyRequest {
    authenticatedUser: AuthenticatedUser | undefined;
  }
}

export interface RequestAuthenticator {
  authenticate(credential: string): Promise<AuthenticatedUser | undefined>;
}

export function registerIdentityAuthentication(
  app: FastifyInstance,
  authenticator: RequestAuthenticator,
): void {
  app.decorateRequest('authenticatedUser', undefined);
  app.addHook('onRequest', async (request) => {
    const credential = readCookie(request.headers.cookie, SESSION_COOKIE_NAME);
    request.authenticatedUser =
      credential === undefined ? undefined : await authenticator.authenticate(credential);
  });
}

export function requireAuthenticatedUser(
  request: FastifyRequest,
  reply: FastifyReply,
  done: HookHandlerDoneFunction,
): void {
  if (request.authenticatedUser !== undefined) {
    done();
    return;
  }

  reply.header('set-cookie', clearSessionCookie());
  const body: ApiError = apiError(ErrorCode.UNAUTHENTICATED, 'Authentication required.');
  reply.status(401).send(body);
}

export function sessionCookie(credential: string, expiresAt: Date, secure: boolean): string {
  const secureAttribute = secure ? '; Secure' : '';
  return `${SESSION_COOKIE_NAME}=${credential}; Path=/; HttpOnly; SameSite=Lax; Expires=${expiresAt.toUTCString()}${secureAttribute}`;
}

export function clearSessionCookie(secure = false): string {
  const secureAttribute = secure ? '; Secure' : '';
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureAttribute}`;
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    const value = part.slice(separator + 1).trim();
    return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : undefined;
  }
  return undefined;
}
