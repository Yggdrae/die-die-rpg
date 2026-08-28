import { describe, expect, test } from 'bun:test';

import { Argon2PasswordHasher, needsArgon2Rehash } from './password-hasher.ts';

describe('Argon2PasswordHasher', () => {
  test('uses and verifies the frozen Argon2id parameters', async () => {
    const hasher = new Argon2PasswordHasher();
    const encoded = await hasher.hash('correct horse battery staple');

    expect(encoded).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=1\$/);
    expect(await hasher.verify(encoded, 'correct horse battery staple')).toEqual({
      valid: true,
      needsRehash: false,
    });
    expect(await hasher.verify(encoded, 'incorrect password value')).toEqual({
      valid: false,
      needsRehash: false,
    });
  });

  test('marks weaker or non-current hashes for replacement', () => {
    expect(
      needsArgon2Rehash(`$argon2id$v=19$m=32768,t=3,p=1$c2FsdHNhbHRzYWx0MTY$${'eA'.repeat(22)}`),
    ).toBe(true);
    expect(needsArgon2Rehash('$argon2i$v=19$m=65536,t=3,p=1$salt$output')).toBe(true);
  });
});
