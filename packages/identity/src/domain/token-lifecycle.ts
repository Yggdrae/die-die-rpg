export interface TokenLifecycleInput {
  readonly expiresAt: Date;
  readonly usedAt?: Date;
  readonly revokedAt?: Date;
}

export type TokenLifecycle = 'usable' | 'used' | 'revoked' | 'expired';

/** Expiry is exclusive: a token is expired when database time equals its expiry. */
export function evaluateTokenLifecycle(
  token: TokenLifecycleInput,
  databaseNow: Date,
): TokenLifecycle {
  if (token.usedAt !== undefined) {
    return 'used';
  }
  if (token.revokedAt !== undefined) {
    return 'revoked';
  }
  if (databaseNow.getTime() >= token.expiresAt.getTime()) {
    return 'expired';
  }
  return 'usable';
}
