import { describe, expect, test } from 'bun:test';
import { buildApp } from '../../app.ts';
import { FixedWindowRateLimit } from '../security.ts';
import { registerIdentityAuthentication } from './authenticate.ts';
import { type IdentityRouteServices, registerIdentityRoutes } from './routes.ts';

const userId = '11111111-1111-1111-1111-111111111111';
const sessionId = '22222222-2222-2222-2222-222222222222';
const credential = 'A'.repeat(43);
const origin = 'https://table.invalid';

function services(): IdentityRouteServices {
  const view = {
    user: { id: userId, username: 'Table_GM' },
    session: {
      id: sessionId,
      createdAt: '2026-08-30T12:00:00Z',
      expiresAt: '2026-09-29T12:00:00Z',
      current: true,
    },
  };
  return {
    accounts: {
      createAccount: async () => ({ ok: true, value: { view, credential } }),
      login: async () => ({ ok: false, error: 'invalid_credentials' }),
      logout: async () => undefined,
    },
    recovery: { consume: async () => ({ ok: true, value: undefined }) },
    invitations: {
      preview: async () => ({ ok: false, error: 'unusable_invitation' }),
      accept: async () => ({ ok: false, error: 'unusable_invitation' }),
      issue: async () => ({ ok: false, error: 'not_found_or_forbidden' }),
      revoke: async () => ({ ok: false, error: 'not_found_or_forbidden' }),
      list: async () => ({ ok: false, error: 'not_found_or_forbidden' }),
    },
    memberships: {
      listCampaign: async () => ({ ok: false, error: 'not_found_or_forbidden' }),
      listUser: async () => ({ items: [] }),
      remove: async () => ({ ok: false, error: 'not_found_or_forbidden' }),
      changeRole: async () => ({ ok: false, error: 'not_found_or_forbidden' }),
      transferOwnership: async () => ({ ok: false, error: 'not_found_or_forbidden' }),
    },
  } as unknown as IdentityRouteServices;
}

function harness(rateLimit = new FixedWindowRateLimit(10, 60_000)) {
  const app = buildApp();
  registerIdentityAuthentication(app, {
    authenticate: async (candidate) =>
      candidate === credential ? { userId, sessionId } : undefined,
  });
  registerIdentityRoutes(app, services(), {
    allowedOrigin: origin,
    secureCookies: true,
    rateLimit,
  });
  return app;
}

describe('Fastify identity routes', () => {
  test('signup sets a secure opaque cookie and returns no credential', async () => {
    const app = harness();
    const response = await app.inject({
      method: 'POST',
      url: '/auth/accounts',
      payload: { username: 'Table_GM', password: 'valid password material' },
    });
    expect(response.statusCode).toBe(200);
    expect(String(response.headers['set-cookie'])).toContain('HttpOnly');
    expect(String(response.headers['set-cookie'])).toContain('Secure');
    expect(response.body).not.toContain(credential);
    await app.close();
  });

  test('rejects client role claims instead of silently stripping them', async () => {
    const app = harness();
    const response = await app.inject({
      method: 'POST',
      url: '/auth/accounts',
      payload: { username: 'Table_GM', password: 'valid password material', role: 'owner' },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  test('logout requires same origin and clears the cookie', async () => {
    const app = harness();
    const denied = await app.inject({
      method: 'DELETE',
      url: '/auth/session',
      headers: { cookie: `rpg_session=${credential}`, origin: 'https://attacker.invalid' },
    });
    const accepted = await app.inject({
      method: 'DELETE',
      url: '/auth/session',
      headers: { cookie: `rpg_session=${credential}`, origin },
    });
    expect(denied.statusCode).toBe(403);
    expect(accepted.statusCode).toBe(204);
    expect(String(accepted.headers['set-cookie'])).toContain('Max-Age=0');
    await app.close();
  });

  test('rate limits login without exposing account existence', async () => {
    const app = harness(new FixedWindowRateLimit(1, 60_000));
    const payload = { username: 'Table_GM', password: 'valid password material' };
    const first = await app.inject({ method: 'POST', url: '/auth/sessions', payload });
    const second = await app.inject({ method: 'POST', url: '/auth/sessions', payload });
    expect(first.statusCode).toBe(401);
    expect(second.statusCode).toBe(429);
    expect(first.body).not.toContain('Table_GM');
    await app.close();
  });
});
