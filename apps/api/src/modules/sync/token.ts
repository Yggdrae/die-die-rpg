import type { SyncTokenIssuer } from '@rpg/sync';

export class HmacSyncTokenIssuer implements SyncTokenIssuer {
  readonly #keyBytes: Uint8Array;

  constructor(secret: string) {
    this.#keyBytes = decodeBase64Url(secret);
    if (this.#keyBytes.length < 32) throw new Error('POWERSYNC_JWT_SECRET too short');
  }

  async issue(input: {
    readonly userId: string;
    readonly campaignId: string;
    readonly replicaId: string;
    readonly expiresAt: Date;
  }): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const header = encode({ alg: 'HS256', typ: 'JWT', kid: 'rpg-sync-hs256' });
    const payload = encode({
      sub: input.userId,
      aud: 'powersync',
      iat: now,
      exp: Math.floor(input.expiresAt.getTime() / 1000),
      campaign_id: input.campaignId,
      replica_id: input.replicaId,
    });
    const rawKey = new ArrayBuffer(this.#keyBytes.length);
    new Uint8Array(rawKey).set(this.#keyBytes);
    const key = await crypto.subtle.importKey(
      'raw',
      rawKey,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const signature = await crypto.subtle.sign(
      'HMAC',
      key,
      new TextEncoder().encode(`${header}.${payload}`),
    );
    return `${header}.${payload}.${base64Url(new Uint8Array(signature))}`;
  }
}

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('POWERSYNC_JWT_SECRET must be base64url');
  const padded = value
    .replaceAll('-', '+')
    .replaceAll('_', '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=');
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function encode(value: unknown): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function base64Url(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
