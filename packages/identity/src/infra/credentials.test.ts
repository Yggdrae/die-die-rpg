import { describe, expect, test } from 'bun:test';

import { digestOpaqueCredential, generateOpaqueCredential } from './credentials.ts';

describe('opaque credentials', () => {
  test('generates 32 random bytes as unpadded base64url', () => {
    const credentials = new Set(Array.from({ length: 32 }, generateOpaqueCredential));
    expect(credentials.size).toBe(32);
    for (const credential of credentials) {
      expect(credential).toMatch(/^[A-Za-z0-9_-]{43}$/);
    }
  });

  test('creates a stable 32-byte digest without retaining the credential', async () => {
    const first = await digestOpaqueCredential('a'.repeat(43));
    const second = await digestOpaqueCredential('a'.repeat(43));
    expect(first).toHaveLength(32);
    expect(first).toEqual(second);
  });
});
