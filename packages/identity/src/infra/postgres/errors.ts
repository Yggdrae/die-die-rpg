export type IdentityPersistenceError =
  | 'duplicate_username'
  | 'duplicate_credential'
  | 'constraint_violation'
  | 'persistence_unavailable';

interface PostgreSqlErrorShape {
  readonly code?: unknown;
  readonly constraint_name?: unknown;
  readonly cause?: unknown;
}

export function mapIdentityPersistenceError(error: unknown): IdentityPersistenceError {
  const postgresError = findPostgreSqlError(error);
  if (
    postgresError.code === '23505' &&
    (postgresError.constraint_name === 'identity_users_username_normalized_uidx' ||
      postgresError.constraint_name === 'identity_bindings_provider_subject_uidx')
  ) {
    return 'duplicate_username';
  }
  if (
    postgresError.code === '23505' &&
    (postgresError.constraint_name === 'identity_sessions_credential_digest_uidx' ||
      postgresError.constraint_name === 'identity_recovery_tokens_digest_uidx')
  ) {
    return 'duplicate_credential';
  }
  if (typeof postgresError.code === 'string' && postgresError.code.startsWith('23')) {
    return 'constraint_violation';
  }
  return 'persistence_unavailable';
}

function findPostgreSqlError(error: unknown): PostgreSqlErrorShape {
  let current = error;
  for (let depth = 0; depth < 5 && current !== null && typeof current === 'object'; depth += 1) {
    const candidate = current as PostgreSqlErrorShape;
    if (typeof candidate.code === 'string') {
      return candidate;
    }
    current = candidate.cause;
  }
  return {};
}

const REDACTED_KEYS = new Set([
  'credential',
  'credentialDigest',
  'credential_digest',
  'password',
  'passwordHash',
  'password_hash',
  'token',
  'tokenDigest',
  'token_digest',
]);

export function redactIdentityDiagnostic(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactIdentityDiagnostic);
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      REDACTED_KEYS.has(key) ? '[REDACTED]' : redactIdentityDiagnostic(entry),
    ]),
  );
}
