import { afterAll, describe, expect, test } from 'bun:test';
import type { Algorithm, Version } from '@node-rs/argon2';
import { hash } from '@node-rs/argon2';
import { count, eq, sql } from 'drizzle-orm';

import { AccountSessionService } from '../../application/account-session-service.ts';
import { RecoveryService } from '../../application/recovery-service.ts';
import { normalizeUsername } from '../../domain/username.ts';
import { digestOpaqueCredential, generateOpaqueCredential } from '../credentials.ts';
import { Argon2PasswordHasher } from '../password-hasher.ts';
import { connectIdentityDatabase, inIdentityTransaction } from './database.ts';
import { AccountRepository, RecoveryTokenRepository, SessionRepository } from './repositories.ts';
import {
  identityBindings,
  identityPasswordCredentials,
  identityRecoveryTokens,
  identitySessions,
  identityUsers,
} from './schema.ts';

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const connection = databaseUrl === undefined ? undefined : connectIdentityDatabase(databaseUrl);
const database = connection?.db;

afterAll(async () => {
  await connection?.close();
});

function accountInput(username: string) {
  const normalized = normalizeUsername(username);
  if (!normalized.ok) {
    throw new Error('integration-test username is invalid');
  }
  return {
    userId: crypto.randomUUID(),
    bindingId: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    username: normalized.value,
    passwordHash: '$argon2id$v=19$m=65536,t=3,p=1$redacted-test-value',
    sessionCredentialDigest: crypto.getRandomValues(new Uint8Array(32)),
  };
}

describe.skipIf(database === undefined)('PostgreSQL identity repositories', () => {
  test('concurrent normalized-username inserts produce one complete account', async () => {
    if (database === undefined) return;
    const suffix = crypto.randomUUID().slice(0, 8);
    const repository = new AccountRepository(database);
    const first = accountInput(`Table_${suffix}`);
    const second = accountInput(`table_${suffix}`);

    const results = await Promise.all([
      repository.createWithSession(first),
      repository.createWithSession(second),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      { ok: false, error: 'duplicate_username' },
    ]);

    const [users] = await database
      .select({ count: count() })
      .from(identityUsers)
      .where(eq(identityUsers.usernameNormalized, first.username.normalized));
    const [bindings] = await database
      .select({ count: count() })
      .from(identityBindings)
      .where(eq(identityBindings.providerSubject, first.username.normalized));
    const [credentials] = await database
      .select({ count: count() })
      .from(identityPasswordCredentials)
      .innerJoin(identityUsers, eq(identityUsers.id, identityPasswordCredentials.userId))
      .where(eq(identityUsers.usernameNormalized, first.username.normalized));
    const [sessions] = await database
      .select({ count: count() })
      .from(identitySessions)
      .innerJoin(identityUsers, eq(identityUsers.id, identitySessions.userId))
      .where(eq(identityUsers.usernameNormalized, first.username.normalized));

    expect([users?.count, bindings?.count, credentials?.count, sessions?.count]).toEqual([
      1, 1, 1, 1,
    ]);
  });

  test('a dependent-row constraint failure rolls back every account row', async () => {
    if (database === undefined) return;
    const repository = new AccountRepository(database);
    const input = accountInput(`Rollback_${crypto.randomUUID().slice(0, 8)}`);
    const result = await repository.createWithSession({
      ...input,
      sessionCredentialDigest: new Uint8Array(31),
    });

    expect(result).toEqual({ ok: false, error: 'constraint_violation' });
    const [account] = await database
      .select({ count: count() })
      .from(identityUsers)
      .where(eq(identityUsers.id, input.userId));
    expect(account?.count).toBe(0);
    const [dependentRows] = await database.execute<{ count: number }>(sql`
      select (
        (select count(*) from identity_bindings where user_id = ${input.userId}) +
        (select count(*) from identity_password_credentials where user_id = ${input.userId}) +
        (select count(*) from identity_sessions where user_id = ${input.userId})
      )::int as count
    `);
    expect(dependentRows?.count).toBe(0);
  });

  test('active lookup excludes revoked sessions and the exact expiry instant', async () => {
    if (database === undefined) return;
    const accountRepository = new AccountRepository(database);
    const input = accountInput(`Session_${crypto.randomUUID().slice(0, 8)}`);
    const created = await accountRepository.createWithSession(input);
    expect(created.ok).toBe(true);

    const sessions = new SessionRepository(database);
    expect(await sessions.findActiveByDigest(input.sessionCredentialDigest)).toMatchObject({
      id: input.sessionId,
      userId: input.userId,
    });
    expect(await sessions.revokeById(input.sessionId, input.userId)).toBe(true);
    expect(await sessions.findActiveByDigest(input.sessionCredentialDigest)).toBeUndefined();

    await inIdentityTransaction(database, async (transaction) => {
      const expiryDigest = crypto.getRandomValues(new Uint8Array(32));
      await transaction.insert(identitySessions).values({
        id: crypto.randomUUID(),
        userId: input.userId,
        credentialDigest: expiryDigest,
        createdAt: sql`transaction_timestamp() - interval '30 days'`,
        expiresAt: sql`transaction_timestamp()`,
      });
      expect(
        await new SessionRepository(transaction).findActiveByDigest(expiryDigest),
      ).toBeUndefined();
    });
  });

  test('account creation, login, authentication, and logout use only opaque credentials', async () => {
    if (database === undefined) return;
    const accounts = new AccountRepository(database);
    const sessions = new SessionRepository(database);
    const service = new AccountSessionService(accounts, sessions, new Argon2PasswordHasher(), {
      accountCreated: () => undefined,
      loginSucceeded: () => undefined,
      loginFailed: () => undefined,
      sessionRevoked: () => undefined,
    });
    const username = `Auth_${crypto.randomUUID().slice(0, 8)}`;
    const password = 'correct horse battery staple';

    const created = await service.createAccount({ username, password });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(await service.authenticate(created.value.credential)).toMatchObject({
      userId: created.value.view.user.id,
      sessionId: created.value.view.session.id,
    });

    const invalid = await service.login({ username, password: 'incorrect password material' });
    expect(invalid).toEqual({ ok: false, error: 'invalid_credentials' });

    const weakHash = await hash(password, {
      algorithm: 2 as Algorithm,
      version: 1 as Version,
      memoryCost: 32_768,
      timeCost: 2,
      parallelism: 1,
      outputLen: 32,
      salt: crypto.getRandomValues(new Uint8Array(16)),
    });
    await database
      .update(identityPasswordCredentials)
      .set({ passwordHash: weakHash })
      .where(eq(identityPasswordCredentials.userId, created.value.view.user.id));

    const loggedIn = await service.login({ username: username.toUpperCase(), password });
    expect(loggedIn.ok).toBe(true);
    if (!loggedIn.ok) return;
    expect(await service.authenticate(loggedIn.value.credential)).toMatchObject({
      userId: created.value.view.user.id,
      sessionId: loggedIn.value.view.session.id,
    });

    await service.logout({
      userId: loggedIn.value.view.user.id,
      sessionId: loggedIn.value.view.session.id,
    });
    await service.logout({
      userId: loggedIn.value.view.user.id,
      sessionId: loggedIn.value.view.session.id,
    });
    expect(await service.authenticate(loggedIn.value.credential)).toBeUndefined();

    const stored = await accounts.findLocalCredentialByUsername(username.toLowerCase());
    expect(stored?.passwordHash).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=1\$/);
    expect(stored?.passwordHash).not.toBe(weakHash);
    expect(stored?.passwordHash).not.toContain(password);
    expect(JSON.stringify(created.value.view)).not.toContain(password);
    expect(JSON.stringify(created.value.view)).not.toContain(created.value.credential);
  });

  test('recovery rejects every unusable state and has exactly one concurrent consumer', async () => {
    if (database === undefined) return;
    const accounts = new AccountRepository(database);
    const sessions = new SessionRepository(database);
    const passwordHasher = new Argon2PasswordHasher();
    const authentication = new AccountSessionService(accounts, sessions, passwordHasher, {
      accountCreated: () => undefined,
      loginSucceeded: () => undefined,
      loginFailed: () => undefined,
      sessionRevoked: () => undefined,
    });
    const recovery = new RecoveryService(
      new RecoveryTokenRepository(database),
      passwordHasher,
      { recordIssued: async () => undefined },
      {
        recoveryIssued: () => undefined,
        recoveryIssuanceAuditDegraded: () => undefined,
        recoverySucceeded: () => undefined,
        recoveryFailed: () => undefined,
      },
    );
    const username = `Recover_${crypto.randomUUID().slice(0, 8)}`;
    const oldPassword = 'old correct horse battery staple';
    const created = await authentication.createAccount({ username, password: oldPassword });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const userId = created.value.view.user.id;

    const loggedIn = await authentication.login({ username, password: oldPassword });
    expect(loggedIn.ok).toBe(true);
    if (!loggedIn.ok) return;

    const unusableCredentials = {
      expired: generateOpaqueCredential(),
      used: generateOpaqueCredential(),
      revoked: generateOpaqueCredential(),
      unknown: generateOpaqueCredential(),
    };
    await database.insert(identityRecoveryTokens).values([
      {
        id: crypto.randomUUID(),
        userId,
        tokenDigest: await digestOpaqueCredential(unusableCredentials.expired),
        issuedAt: sql`transaction_timestamp() - interval '30 minutes'`,
        expiresAt: sql`transaction_timestamp()`,
      },
      {
        id: crypto.randomUUID(),
        userId,
        tokenDigest: await digestOpaqueCredential(unusableCredentials.used),
        expiresAt: sql`transaction_timestamp() + interval '30 minutes'`,
        usedAt: sql`transaction_timestamp()`,
      },
      {
        id: crypto.randomUUID(),
        userId,
        tokenDigest: await digestOpaqueCredential(unusableCredentials.revoked),
        expiresAt: sql`transaction_timestamp() + interval '30 minutes'`,
        revokedAt: sql`transaction_timestamp()`,
      },
    ]);

    for (const credential of Object.values(unusableCredentials)) {
      expect(
        await recovery.consume({ credential, newPassword: 'replacement password material' }),
      ).toEqual({ ok: false, error: 'unusable_token' });
    }
    const unchanged = await accounts.findLocalCredentialByUsername(username.toLowerCase());
    expect(await passwordHasher.verify(unchanged?.passwordHash ?? '', oldPassword)).toMatchObject({
      valid: true,
    });
    expect(await authentication.authenticate(created.value.credential)).toBeDefined();
    expect(await authentication.authenticate(loggedIn.value.credential)).toBeDefined();

    const superseded = await recovery.issue({ username, operatorReference: 'test:older' });
    const issued = await recovery.issue({ username, operatorReference: 'test:race' });
    expect(superseded.ok).toBe(true);
    expect(issued.ok).toBe(true);
    if (!superseded.ok || !issued.ok) return;
    expect(
      await recovery.consume({
        credential: superseded.value.credential,
        newPassword: 'superseded replacement password',
      }),
    ).toEqual({ ok: false, error: 'unusable_token' });

    const candidatePasswords = ['first concurrent password', 'second concurrent password'];
    const results = await Promise.all(
      candidatePasswords.map((newPassword) =>
        recovery.consume({ credential: issued.value.credential, newPassword }),
      ),
    );
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      { ok: false, error: 'unusable_token' },
    ]);

    const winnerIndex = results.findIndex((result) => result.ok);
    const changed = await accounts.findLocalCredentialByUsername(username.toLowerCase());
    expect(
      await passwordHasher.verify(
        changed?.passwordHash ?? '',
        candidatePasswords[winnerIndex] ?? '',
      ),
    ).toMatchObject({ valid: true });
    expect(await authentication.authenticate(created.value.credential)).toBeUndefined();
    expect(await authentication.authenticate(loggedIn.value.credential)).toBeUndefined();

    const [consumed] = await database
      .select({ usedAt: identityRecoveryTokens.usedAt })
      .from(identityRecoveryTokens)
      .where(eq(identityRecoveryTokens.id, issued.value.tokenId));
    expect(consumed?.usedAt).toBeInstanceOf(Date);
  });
});
