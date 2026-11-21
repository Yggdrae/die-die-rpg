import { describe, expect, test } from 'bun:test';

import { normalizeUsername } from './username.ts';

describe('normalizeUsername', () => {
  test('trims ASCII edge whitespace and lowercases ASCII letters', () => {
    expect(normalizeUsername(' \tTable_GM\r\n')).toEqual({
      ok: true,
      value: { display: 'Table_GM', normalized: 'table_gm' },
    });
  });

  test.each([
    ['too short', 'ab'],
    ['too long', 'abcdefghijklmnopqrstuvwxyz1234567'],
    ['invalid first character', '_tablegm'],
    ['embedded whitespace', 'table gm'],
    ['non-ASCII character', 'josé'],
    ['non-ASCII edge whitespace', '\u00a0tablegm\u00a0'],
  ])('rejects %s', (_label, username) => {
    expect(normalizeUsername(username)).toEqual({ ok: false, error: 'invalid_username' });
  });
});
