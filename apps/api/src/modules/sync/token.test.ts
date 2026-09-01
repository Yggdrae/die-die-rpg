import { describe, expect, test } from 'bun:test';
import { HmacSyncTokenIssuer } from './token.ts';

const SECRET = 'ZGV2ZWxvcG1lbnQtb25seS1wb3dlcnN5bmMta2V5LTMyIQ';

describe('HmacSyncTokenIssuer', () => {
  test('issues a verifiable PowerSync-scoped HS256 token', async () => {
    const expiresAt = new Date('2026-08-31T10:05:00Z');
    const token = await new HmacSyncTokenIssuer(SECRET).issue({
      userId: '00000000-0000-4000-8000-000000000001',
      campaignId: '00000000-0000-4000-8000-000000000002',
      replicaId: '00000000-0000-4000-8000-000000000003',
      expiresAt,
    });
    const [headerPart, payloadPart, signaturePart] = token.split('.');
    if (headerPart === undefined || payloadPart === undefined || signaturePart === undefined) {
      throw new Error('invalid test token');
    }
    expect(decodePart(headerPart)).toEqual({
      alg: 'HS256',
      typ: 'JWT',
      kid: 'rpg-sync-hs256',
    });
    expect(decodePart(payloadPart)).toMatchObject({
      sub: '00000000-0000-4000-8000-000000000001',
      aud: 'powersync',
      exp: expiresAt.getTime() / 1_000,
      campaign_id: '00000000-0000-4000-8000-000000000002',
      replica_id: '00000000-0000-4000-8000-000000000003',
    });

    const key = await crypto.subtle.importKey(
      'raw',
      Uint8Array.from(atob(toBase64(SECRET)), (character) => character.charCodeAt(0)),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    expect(
      await crypto.subtle.verify(
        'HMAC',
        key,
        Uint8Array.from(atob(toBase64(signaturePart)), (character) => character.charCodeAt(0)),
        new TextEncoder().encode(`${headerPart}.${payloadPart}`),
      ),
    ).toBe(true);
  });

  test('rejects invalid or short secrets', () => {
    expect(() => new HmacSyncTokenIssuer('not+base64')).toThrow(
      'POWERSYNC_JWT_SECRET must be base64url',
    );
    expect(() => new HmacSyncTokenIssuer('c2hvcnQ')).toThrow('POWERSYNC_JWT_SECRET too short');
  });
});

function decodePart(value: string): unknown {
  return JSON.parse(atob(toBase64(value)));
}

function toBase64(value: string): string {
  return value
    .replaceAll('-', '+')
    .replaceAll('_', '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=');
}
