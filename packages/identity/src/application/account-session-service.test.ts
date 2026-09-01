import { describe, expect, mock, test } from 'bun:test';

import type { PasswordHasher } from '../infra/password-hasher.ts';
import {
  AccountSessionService,
  type IdentityAccountSessionStore,
  type IdentityAuthenticationLog,
  type IdentitySessionStore,
} from './account-session-service.ts';

const createdAt = new Date('2026-08-27T00:00:00.000Z');
const expiresAt = new Date('2026-09-26T00:00:00.000Z');

function fixtures() {
  const accounts: IdentityAccountSessionStore = {
    createWithSession: mock(async (input) => ({
      ok: true as const,
      value: {
        userId: input.userId,
        sessionId: input.sessionId,
        username: input.username.display,
        createdAt,
        expiresAt,
      },
    })),
    findLocalCredentialByUsername: mock(async () => ({
      userId: '11111111-1111-1111-1111-111111111111',
      username: 'Table_GM',
      passwordHash: 'stored-hash',
    })),
    createLoginSession: mock(async () => ({
      ok: true as const,
      value: { createdAt, expiresAt },
    })),
  };
  const sessions: IdentitySessionStore = {
    findActiveByDigest: mock(async () => ({
      id: '22222222-2222-2222-2222-222222222222',
      userId: '11111111-1111-1111-1111-111111111111',
      createdAt,
      expiresAt,
      lastSeenAt: null,
    })),
    revokeById: mock(async () => true),
  };
  const passwords: PasswordHasher = {
    hash: mock(async () => 'new-hash'),
    verify: mock(async () => ({ valid: true, needsRehash: false })),
  };
  const log: IdentityAuthenticationLog = {
    accountCreated: mock(() => undefined),
    loginSucceeded: mock(() => undefined),
    loginFailed: mock(() => undefined),
    sessionRevoked: mock(() => undefined),
  };
  return { accounts, sessions, passwords, log };
}

describe('AccountSessionService', () => {
  test('creates an atomic account session without returning persisted secrets', async () => {
    const dependencies = fixtures();
    const service = new AccountSessionService(
      dependencies.accounts,
      dependencies.sessions,
      dependencies.passwords,
      dependencies.log,
    );

    const result = await service.createAccount({
      username: '  Table_GM  ',
      password: 'correct horse battery staple',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.credential).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(result.value.view)).not.toContain('correct horse');
    expect(JSON.stringify(result.value.view)).not.toContain('new-hash');
    expect(JSON.stringify(result.value.view)).not.toContain(result.value.credential);
    expect(dependencies.accounts.createWithSession).toHaveBeenCalledTimes(1);
  });

  test('rejects invalid account input before hashing', async () => {
    const dependencies = fixtures();
    const service = new AccountSessionService(
      dependencies.accounts,
      dependencies.sessions,
      dependencies.passwords,
      dependencies.log,
    );

    expect(await service.createAccount({ username: '_bad', password: 'a'.repeat(15) })).toEqual({
      ok: false,
      error: 'invalid_username',
    });
    expect(dependencies.passwords.hash).not.toHaveBeenCalled();
    expect(dependencies.accounts.createWithSession).not.toHaveBeenCalled();
  });

  test('uses one generic invalid-login result and issues no session', async () => {
    const dependencies = fixtures();
    dependencies.accounts.findLocalCredentialByUsername = mock(async () => undefined);
    const service = new AccountSessionService(
      dependencies.accounts,
      dependencies.sessions,
      dependencies.passwords,
      dependencies.log,
    );

    expect(
      await service.login({ username: 'missing_user', password: 'not disclosed anywhere' }),
    ).toEqual({
      ok: false,
      error: 'invalid_credentials',
    });
    expect(dependencies.accounts.createLoginSession).not.toHaveBeenCalled();
  });

  test('rehashes only after valid login and issues one session', async () => {
    const dependencies = fixtures();
    dependencies.passwords.verify = mock(async () => ({ valid: true, needsRehash: true }));
    const service = new AccountSessionService(
      dependencies.accounts,
      dependencies.sessions,
      dependencies.passwords,
      dependencies.log,
    );

    const result = await service.login({
      username: 'TABLE_GM',
      password: 'correct horse battery staple',
    });

    expect(result.ok).toBe(true);
    expect(dependencies.passwords.hash).toHaveBeenCalledTimes(1);
    expect(dependencies.accounts.createLoginSession).toHaveBeenCalledTimes(1);
    expect(dependencies.accounts.createLoginSession).toHaveBeenCalledWith(
      expect.objectContaining({ replacementPasswordHash: 'new-hash' }),
    );
  });

  test('authenticates an opaque credential and logout revocation is idempotent', async () => {
    const dependencies = fixtures();
    const service = new AccountSessionService(
      dependencies.accounts,
      dependencies.sessions,
      dependencies.passwords,
      dependencies.log,
    );
    const rawCredential = 'A'.repeat(43);

    expect(await service.authenticate(rawCredential)).toEqual({
      userId: '11111111-1111-1111-1111-111111111111',
      sessionId: '22222222-2222-2222-2222-222222222222',
    });
    await service.logout({
      userId: '11111111-1111-1111-1111-111111111111',
      sessionId: '22222222-2222-2222-2222-222222222222',
    });
    dependencies.sessions.revokeById = mock(async () => false);
    await service.logout({
      userId: '11111111-1111-1111-1111-111111111111',
      sessionId: '22222222-2222-2222-2222-222222222222',
    });

    expect(dependencies.log.sessionRevoked).toHaveBeenCalledTimes(1);
  });
});
