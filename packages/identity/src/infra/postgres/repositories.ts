import { and, eq, gt, isNull, sql } from 'drizzle-orm';

import type { NormalizedUsername } from '../../domain/username.ts';
import type { IdentityDatabase, IdentityExecutor } from './database.ts';
import { inIdentityTransaction } from './database.ts';
import { type IdentityPersistenceError, mapIdentityPersistenceError } from './errors.ts';
import {
  identityBindings,
  identityPasswordCredentials,
  identityRecoveryTokens,
  identitySessions,
  identityUsers,
} from './schema.ts';

export interface AccountInsert {
  readonly userId: string;
  readonly bindingId: string;
  readonly sessionId: string;
  readonly username: NormalizedUsername;
  readonly passwordHash: string;
  readonly sessionCredentialDigest: Uint8Array;
}

export type AccountInsertResult =
  | {
      readonly ok: true;
      readonly value: {
        readonly userId: string;
        readonly sessionId: string;
        readonly username: string;
        readonly createdAt: Date;
        readonly expiresAt: Date;
      };
    }
  | { readonly ok: false; readonly error: IdentityPersistenceError };

export class AccountRepository {
  constructor(private readonly db: IdentityDatabase) {}

  async createWithSession(input: AccountInsert): Promise<AccountInsertResult> {
    try {
      const value = await inIdentityTransaction(this.db, async (transaction) => {
        const [user] = await transaction
          .insert(identityUsers)
          .values({
            id: input.userId,
            usernameDisplay: input.username.display,
            usernameNormalized: input.username.normalized,
          })
          .returning({
            userId: identityUsers.id,
            username: identityUsers.usernameDisplay,
            createdAt: identityUsers.createdAt,
          });
        if (user === undefined) {
          throw new Error('identity user insert returned no row');
        }

        await transaction.insert(identityBindings).values({
          id: input.bindingId,
          userId: input.userId,
          providerKind: 'local',
          providerSubject: input.username.normalized,
        });
        await transaction.insert(identityPasswordCredentials).values({
          userId: input.userId,
          passwordHash: input.passwordHash,
        });
        const [session] = await transaction
          .insert(identitySessions)
          .values({
            id: input.sessionId,
            userId: input.userId,
            credentialDigest: input.sessionCredentialDigest,
            createdAt: user.createdAt,
            expiresAt: new Date(user.createdAt.getTime() + 30 * 24 * 60 * 60 * 1000),
          })
          .returning({ id: identitySessions.id, expiresAt: identitySessions.expiresAt });
        if (session === undefined) {
          throw new Error('identity session insert returned no row');
        }

        return {
          userId: user.userId,
          sessionId: session.id,
          username: user.username,
          createdAt: user.createdAt,
          expiresAt: session.expiresAt,
        };
      });
      return { ok: true, value };
    } catch (error) {
      return { ok: false, error: mapIdentityPersistenceError(error) };
    }
  }

  async findLocalCredentialByUsername(usernameNormalized: string): Promise<
    | {
        readonly userId: string;
        readonly username: string;
        readonly passwordHash: string;
      }
    | undefined
  > {
    const [credential] = await this.db
      .select({
        userId: identityUsers.id,
        username: identityUsers.usernameDisplay,
        passwordHash: identityPasswordCredentials.passwordHash,
      })
      .from(identityUsers)
      .innerJoin(
        identityPasswordCredentials,
        eq(identityPasswordCredentials.userId, identityUsers.id),
      )
      .where(eq(identityUsers.usernameNormalized, usernameNormalized))
      .limit(1);
    return credential;
  }

  async createLoginSession(input: {
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
  > {
    try {
      const value = await inIdentityTransaction(this.db, async (transaction) => {
        if (input.replacementPasswordHash !== undefined) {
          await transaction
            .update(identityPasswordCredentials)
            .set({
              passwordHash: input.replacementPasswordHash,
              changedAt: sql`transaction_timestamp()`,
            })
            .where(eq(identityPasswordCredentials.userId, input.userId));
        }

        const [session] = await transaction
          .insert(identitySessions)
          .values({
            id: input.sessionId,
            userId: input.userId,
            credentialDigest: input.credentialDigest,
            createdAt: sql`transaction_timestamp()`,
            expiresAt: sql`transaction_timestamp() + interval '30 days'`,
          })
          .returning({
            createdAt: identitySessions.createdAt,
            expiresAt: identitySessions.expiresAt,
          });
        if (session === undefined) {
          throw new Error('identity login-session insert returned no row');
        }
        return session;
      });
      return { ok: true, value };
    } catch (error) {
      return { ok: false, error: mapIdentityPersistenceError(error) };
    }
  }
}

export interface ActiveSession {
  readonly id: string;
  readonly userId: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly lastSeenAt: Date | null;
}

export class SessionRepository {
  constructor(private readonly db: IdentityExecutor) {}

  async findActiveByDigest(credentialDigest: Uint8Array): Promise<ActiveSession | undefined> {
    const [session] = await this.db
      .select({
        id: identitySessions.id,
        userId: identitySessions.userId,
        createdAt: identitySessions.createdAt,
        expiresAt: identitySessions.expiresAt,
        lastSeenAt: identitySessions.lastSeenAt,
      })
      .from(identitySessions)
      .where(
        and(
          eq(identitySessions.credentialDigest, credentialDigest),
          isNull(identitySessions.revokedAt),
          gt(identitySessions.expiresAt, sql`transaction_timestamp()`),
        ),
      )
      .limit(1);
    return session;
  }

  async revokeById(sessionId: string, userId: string): Promise<boolean> {
    const revoked = await this.db
      .update(identitySessions)
      .set({ revokedAt: sql`transaction_timestamp()` })
      .where(
        and(
          eq(identitySessions.id, sessionId),
          eq(identitySessions.userId, userId),
          isNull(identitySessions.revokedAt),
        ),
      )
      .returning({ id: identitySessions.id });
    return revoked.length === 1;
  }
}

export interface RecoveryTokenInsert {
  readonly id: string;
  readonly userId: string;
  readonly tokenDigest: Uint8Array;
  readonly operatorReference?: string;
}

export interface IssuedRecoveryTokenRecord {
  readonly tokenId: string;
  readonly userId: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
}

export type RecoveryTokenIssueResult =
  | { readonly ok: true; readonly value: IssuedRecoveryTokenRecord }
  | { readonly ok: false; readonly error: 'user_not_found' | IdentityPersistenceError };

export type RecoveryTokenConsumeResult =
  | {
      readonly ok: true;
      readonly value: { readonly tokenId: string; readonly userId: string };
    }
  | { readonly ok: false; readonly error: 'unusable_token' | IdentityPersistenceError };

export class RecoveryTokenRepository {
  constructor(private readonly db: IdentityDatabase) {}

  async issueForUsername(
    usernameNormalized: string,
    input: Omit<RecoveryTokenInsert, 'userId'>,
  ): Promise<RecoveryTokenIssueResult> {
    try {
      const value = await inIdentityTransaction(this.db, async (transaction) => {
        const [user] = await transaction
          .select({ id: identityUsers.id })
          .from(identityUsers)
          .where(eq(identityUsers.usernameNormalized, usernameNormalized))
          .limit(1)
          .for('update');
        if (user === undefined) return undefined;

        await transaction
          .update(identityRecoveryTokens)
          .set({ revokedAt: sql`transaction_timestamp()` })
          .where(
            and(
              eq(identityRecoveryTokens.userId, user.id),
              isNull(identityRecoveryTokens.usedAt),
              isNull(identityRecoveryTokens.revokedAt),
            ),
          );
        const [token] = await transaction
          .insert(identityRecoveryTokens)
          .values({
            id: input.id,
            userId: user.id,
            tokenDigest: input.tokenDigest,
            operatorReference: input.operatorReference,
            expiresAt: sql`transaction_timestamp() + interval '30 minutes'`,
          })
          .returning({
            tokenId: identityRecoveryTokens.id,
            issuedAt: identityRecoveryTokens.issuedAt,
            expiresAt: identityRecoveryTokens.expiresAt,
          });
        if (token === undefined) {
          throw new Error('identity recovery-token insert returned no row');
        }
        return { ...token, userId: user.id };
      });
      return value === undefined ? { ok: false, error: 'user_not_found' } : { ok: true, value };
    } catch (error) {
      return { ok: false, error: mapIdentityPersistenceError(error) };
    }
  }

  async consume(input: {
    readonly tokenDigest: Uint8Array;
    readonly replacementPasswordHash: string;
  }): Promise<RecoveryTokenConsumeResult> {
    try {
      const value = await inIdentityTransaction(this.db, async (transaction) => {
        const [token] = await transaction
          .select({
            tokenId: identityRecoveryTokens.id,
            userId: identityRecoveryTokens.userId,
            usable: sql<boolean>`${identityRecoveryTokens.usedAt} IS NULL AND ${identityRecoveryTokens.revokedAt} IS NULL AND ${identityRecoveryTokens.expiresAt} > transaction_timestamp()`,
          })
          .from(identityRecoveryTokens)
          .where(eq(identityRecoveryTokens.tokenDigest, input.tokenDigest))
          .limit(1)
          .for('update');
        if (token === undefined || !token.usable) {
          return undefined;
        }

        const changedCredentials = await transaction
          .update(identityPasswordCredentials)
          .set({
            passwordHash: input.replacementPasswordHash,
            changedAt: sql`transaction_timestamp()`,
          })
          .where(eq(identityPasswordCredentials.userId, token.userId))
          .returning({ userId: identityPasswordCredentials.userId });
        if (changedCredentials.length !== 1) {
          throw new Error('identity recovery changed no password credential');
        }
        await transaction
          .update(identitySessions)
          .set({ revokedAt: sql`transaction_timestamp()` })
          .where(
            and(eq(identitySessions.userId, token.userId), isNull(identitySessions.revokedAt)),
          );
        await transaction
          .update(identityRecoveryTokens)
          .set({ usedAt: sql`transaction_timestamp()` })
          .where(eq(identityRecoveryTokens.id, token.tokenId));
        return { tokenId: token.tokenId, userId: token.userId };
      });
      return value === undefined ? { ok: false, error: 'unusable_token' } : { ok: true, value };
    } catch (error) {
      return { ok: false, error: mapIdentityPersistenceError(error) };
    }
  }
}
