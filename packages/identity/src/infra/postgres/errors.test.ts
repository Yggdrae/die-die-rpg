import { describe, expect, test } from 'bun:test';

import {
  isTransientTransactionFailure,
  mapIdentityPersistenceError,
  redactIdentityDiagnostic,
} from './errors.ts';

describe('identity persistence diagnostics', () => {
  test('maps known PostgreSQL constraints without exposing database detail', () => {
    expect(
      mapIdentityPersistenceError({
        code: '23505',
        constraint_name: 'identity_users_username_normalized_uidx',
        detail: 'Key (username_normalized)=(table_gm) already exists.',
      }),
    ).toBe('duplicate_username');
    expect(mapIdentityPersistenceError({ code: '23514' })).toBe('constraint_violation');
    expect(mapIdentityPersistenceError({ cause: { code: '23514' } })).toBe('constraint_violation');
  });

  test('classifies only serialization and deadlock failures as retryable', () => {
    expect(isTransientTransactionFailure({ code: '40001' })).toBe(true);
    expect(isTransientTransactionFailure({ cause: { code: '40P01' } })).toBe(true);
    expect(isTransientTransactionFailure({ code: '23514' })).toBe(false);
    expect(isTransientTransactionFailure(new Error('network'))).toBe(false);
  });

  test('recursively redacts credential and hash fields', () => {
    expect(
      redactIdentityDiagnostic({
        userId: 'safe-id',
        passwordHash: 'secret-phc',
        nested: { tokenDigest: new Uint8Array([1, 2]), credential: 'secret' },
      }),
    ).toEqual({
      userId: 'safe-id',
      passwordHash: '[REDACTED]',
      nested: { tokenDigest: '[REDACTED]', credential: '[REDACTED]' },
    });
  });
});
