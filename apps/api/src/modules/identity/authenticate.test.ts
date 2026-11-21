import { describe, expect, test } from 'bun:test';
import type { AuthenticatedUser } from '@rpg/identity';

import { buildApp } from '../../app.ts';
import {
  clearSessionCookie,
  registerIdentityAuthentication,
  requireAuthenticatedUser,
  sessionCookie,
} from './authenticate.ts';

const credential = 'A'.repeat(43);
const authenticatedUser: AuthenticatedUser = {
  userId: '11111111-1111-1111-1111-111111111111',
  sessionId: '22222222-2222-2222-2222-222222222222',
};

describe('Fastify identity authentication', () => {
  test('decorates a request only from an active server session', async () => {
    const app = buildApp();
    registerIdentityAuthentication(app, {
      authenticate: async (candidate) => (candidate === credential ? authenticatedUser : undefined),
    });
    app.get('/protected', { preHandler: requireAuthenticatedUser }, async (request) => ({
      userId: request.authenticatedUser?.userId,
      sessionId: request.authenticatedUser?.sessionId,
    }));

    const response = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { cookie: `ignored=value; rpg_session=${credential}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json() as unknown).toEqual(authenticatedUser);
    await app.close();
  });

  test('rejects and clears missing, malformed, or inactive credentials', async () => {
    const observed: string[] = [];
    const app = buildApp();
    registerIdentityAuthentication(app, {
      authenticate: async (candidate) => {
        observed.push(candidate);
        return undefined;
      },
    });
    app.get('/protected', { preHandler: requireAuthenticatedUser }, async () => ({ leaked: true }));

    const missing = await app.inject({ method: 'GET', url: '/protected' });
    const malformed = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { cookie: 'rpg_session=not-valid' },
    });
    const inactive = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { cookie: `rpg_session=${credential}` },
    });

    expect([missing.statusCode, malformed.statusCode, inactive.statusCode]).toEqual([
      401, 401, 401,
    ]);
    expect(observed).toEqual([credential]);
    expect(String(inactive.headers['set-cookie'])).toContain('Max-Age=0');
    expect(inactive.body).not.toContain(credential);
    await app.close();
  });

  test('cookie policy is HttpOnly, SameSite Lax, and Secure in production', () => {
    const issued = sessionCookie(credential, new Date('2026-09-26T00:00:00.000Z'), true);
    expect(issued).toContain('HttpOnly');
    expect(issued).toContain('SameSite=Lax');
    expect(issued).toContain('Secure');
    expect(issued).toContain('Expires=');
    expect(clearSessionCookie(true)).toContain('Max-Age=0; Secure');
  });
});
