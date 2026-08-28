import { describe, expect, test } from 'bun:test';

import { evaluateTokenLifecycle } from './token-lifecycle.ts';

const EXPIRY = new Date('2026-08-27T15:00:00Z');

describe('evaluateTokenLifecycle', () => {
  test('is usable only before expiry with no terminal transition', () => {
    expect(
      evaluateTokenLifecycle({ expiresAt: EXPIRY }, new Date('2026-08-27T14:59:59.999Z')),
    ).toBe('usable');
  });

  test('is expired exactly at the expiry instant', () => {
    expect(evaluateTokenLifecycle({ expiresAt: EXPIRY }, EXPIRY)).toBe('expired');
  });

  test('reports used and revoked terminal states', () => {
    const beforeExpiry = new Date('2026-08-27T14:00:00Z');
    expect(evaluateTokenLifecycle({ expiresAt: EXPIRY, usedAt: beforeExpiry }, beforeExpiry)).toBe(
      'used',
    );
    expect(
      evaluateTokenLifecycle({ expiresAt: EXPIRY, revokedAt: beforeExpiry }, beforeExpiry),
    ).toBe('revoked');
  });
});
