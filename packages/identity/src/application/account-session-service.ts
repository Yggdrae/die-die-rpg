import { err, ok, type Result } from '@rpg/contracts';

import type { AuthenticatedUser } from '../contracts/interfaces.ts';
import type { AccountSessionView } from '../contracts/schemas.ts';
import { validatePassword } from '../domain/password.ts';
import { normalizeUsername } from '../domain/username.ts';
import { digestOpaqueCredential, generateOpaqueCredential } from '../infra/credentials.ts';
import type { PasswordHasher } from '../infra/password-hasher.ts';
import type { IdentityPersistenceError } from '../infra/postgres/errors.ts';

export interface CreatedAccountRecord {
  readonly userId: string;
  readonly sessionId: string;
  readonly username: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

export interface IdentityAccountSessionStore {
  createWithSession(input: {
    readonly userId: string;
    readonly bindingId: string;
    readonly sessionId: string;
    readonly username: { readonly display: string; readonly normalized: string };
    readonly passwordHash: string;
    readonly sessionCredentialDigest: Uint8Array;
  }): Promise<
    | { readonly ok: true; readonly value: CreatedAccountRecord }
    | { readonly ok: false; readonly error: IdentityPersistenceError }
  >;
  findLocalCredentialByUsername(usernameNormalized: string): Promise<
    | {
        readonly userId: string;
        readonly username: string;
        readonly passwordHash: string;
      }
    | undefined
  >;
  createLoginSession(input: {
    readonly userId: string;
    readonly sessionId: string;
    readonly credentialDigest: Uint8Array;
    readonly replacementPasswordHash?: string;
  }): Promise<
    | {
        readonly ok: true;
        readonly value: { readonly createdAt: Date; readonly expiresAt: Date };
      }
    | { readonly ok: false; readonly error: IdentityPersistenceError }
  >;
}

export interface IdentitySessionStore {
  findActiveByDigest(credentialDigest: Uint8Array): Promise<
    | {
        readonly id: string;
        readonly userId: string;
        readonly createdAt: Date;
        readonly expiresAt: Date;
        readonly lastSeenAt: Date | null;
      }
    | undefined
  >;
  revokeById(sessionId: string, userId: string): Promise<boolean>;
}

export interface IdentityAuthenticationLog {
  accountCreated(userId: string): void;
  loginSucceeded(userId: string, sessionId: string): void;
  loginFailed(): void;
  sessionRevoked(sessionId: string): void;
}

export interface IssuedAccountSession {
  readonly view: AccountSessionView;
  /** Issuance-only secret. The HTTP adapter places it in the session cookie, never the body. */
  readonly credential: string;
}

export type AccountCreationError =
  | 'invalid_username'
  | 'invalid_password'
  | 'username_taken'
  | 'identity_unavailable';
export type LoginError = 'invalid_credentials' | 'identity_unavailable';

export class AccountSessionService {
  constructor(
    private readonly accounts: IdentityAccountSessionStore,
    private readonly sessions: IdentitySessionStore,
    private readonly passwords: PasswordHasher,
    private readonly log: IdentityAuthenticationLog,
  ) {}

  async createAccount(input: {
    readonly username: string;
    readonly password: string;
  }): Promise<Result<IssuedAccountSession, AccountCreationError>> {
    const username = normalizeUsername(input.username);
    if (!username.ok) return username;
    const password = validatePassword(input.password);
    if (!password.ok) return password;

    const credential = generateOpaqueCredential();
    const persisted = await this.accounts.createWithSession({
      userId: crypto.randomUUID(),
      bindingId: crypto.randomUUID(),
      sessionId: crypto.randomUUID(),
      username: username.value,
      passwordHash: await this.passwords.hash(password.value),
      sessionCredentialDigest: await digestOpaqueCredential(credential),
    });
    if (!persisted.ok) {
      return err(mapAccountCreationError(persisted.error));
    }

    this.log.accountCreated(persisted.value.userId);
    return ok(toIssuedSession(persisted.value, credential));
  }

  async login(input: {
    readonly username: string;
    readonly password: string;
  }): Promise<Result<IssuedAccountSession, LoginError>> {
    const username = normalizeUsername(input.username);
    if (!username.ok) return this.invalidLogin();

    const credentialRecord = await this.accounts.findLocalCredentialByUsername(
      username.value.normalized,
    );
    if (credentialRecord === undefined) return this.invalidLogin();

    const verification = await this.passwords.verify(credentialRecord.passwordHash, input.password);
    if (!verification.valid) return this.invalidLogin();

    const credential = generateOpaqueCredential();
    const sessionId = crypto.randomUUID();
    const replacementPasswordHash = verification.needsRehash
      ? await this.passwords.hash(input.password)
      : undefined;
    const session = await this.accounts.createLoginSession({
      userId: credentialRecord.userId,
      sessionId,
      credentialDigest: await digestOpaqueCredential(credential),
      replacementPasswordHash,
    });
    if (!session.ok) return err('identity_unavailable');

    this.log.loginSucceeded(credentialRecord.userId, sessionId);
    return ok(
      toIssuedSession(
        {
          userId: credentialRecord.userId,
          sessionId,
          username: credentialRecord.username,
          createdAt: session.value.createdAt,
          expiresAt: session.value.expiresAt,
        },
        credential,
      ),
    );
  }

  async authenticate(credential: string): Promise<AuthenticatedUser | undefined> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(credential)) return undefined;
    const session = await this.sessions.findActiveByDigest(
      await digestOpaqueCredential(credential),
    );
    if (session === undefined) return undefined;
    return { userId: session.userId, sessionId: session.id };
  }

  async logout(user: AuthenticatedUser): Promise<void> {
    if (await this.sessions.revokeById(user.sessionId, user.userId)) {
      this.log.sessionRevoked(user.sessionId);
    }
  }

  private invalidLogin(): Result<never, LoginError> {
    this.log.loginFailed();
    return err('invalid_credentials');
  }
}

function mapAccountCreationError(error: IdentityPersistenceError): AccountCreationError {
  return error === 'duplicate_username' ? 'username_taken' : 'identity_unavailable';
}

function toIssuedSession(record: CreatedAccountRecord, credential: string): IssuedAccountSession {
  return {
    view: {
      user: { id: record.userId, username: record.username },
      session: {
        id: record.sessionId,
        createdAt: record.createdAt.toISOString(),
        expiresAt: record.expiresAt.toISOString(),
        current: true,
      },
    },
    credential,
  };
}
