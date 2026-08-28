import { describe, expect, test } from 'bun:test';

import { validatePassword } from './password.ts';

describe('validatePassword', () => {
  test.each([
    ['14 code points', 'a'.repeat(14)],
    ['129 code points', 'a'.repeat(129)],
    ['more than 512 UTF-8 bytes', `${'🎲'.repeat(128)}a`],
  ])('rejects %s', (_label, password) => {
    expect(validatePassword(password)).toEqual({ ok: false, error: 'invalid_password' });
  });

  test.each([' a'.repeat(8), '🎲'.repeat(128)])('accepts a boundary value exactly', (password) => {
    expect(validatePassword(password)).toEqual({ ok: true, value: password });
  });

  test('does not trim or normalize input', () => {
    const password = `  e\u0301${'x'.repeat(11)}`;
    expect(validatePassword(password)).toEqual({ ok: true, value: password });
    expect(validatePassword(password.normalize('NFC'))).toEqual({
      ok: false,
      error: 'invalid_password',
    });
  });
});
