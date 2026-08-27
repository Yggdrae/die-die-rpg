import { describe, expect, test } from 'bun:test';
import { ApiError, check } from '@rpg/contracts';
import { buildApp } from './app.ts';

describe('api shell', () => {
  test('health responds and matches its declared schema', async () => {
    const app = buildApp({ version: '1.2.3' });
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json() as unknown).toEqual({ status: 'ok', version: '1.2.3' });
    await app.close();
  });

  test('an unknown route returns the shared ApiError shape', async () => {
    const app = buildApp();
    const response = await app.inject({ method: 'GET', url: '/nope' });

    expect(response.statusCode).toBe(404);
    expect(check(ApiError, response.json())).toBe(true);
    await app.close();
  });

  // A miss and a denial must be indistinguishable (feature 04 FR-009). Establishing the
  // code here means feature 04 inherits it rather than inventing a separate one.
  test('a miss does not distinguish itself from a denial', async () => {
    const app = buildApp();
    const response = await app.inject({ method: 'GET', url: '/nope' });

    expect((response.json() as ApiError).code).toBe('not_found_or_forbidden');
    await app.close();
  });

  test('an error body leaks no internal detail', async () => {
    const app = buildApp();
    app.get('/boom', async () => {
      throw new Error('connection string postgres://user:secret@host/db');
    });

    const response = await app.inject({ method: 'GET', url: '/boom' });
    const body = response.body;

    expect(response.statusCode).toBe(500);
    expect(body).not.toContain('postgres://');
    expect(body).not.toContain('secret');
    expect(check(ApiError, response.json())).toBe(true);
    await app.close();
  });
});
