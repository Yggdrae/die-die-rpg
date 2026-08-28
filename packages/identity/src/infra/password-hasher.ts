import type { Algorithm, Options, Version } from '@node-rs/argon2';
import { hash, verify } from '@node-rs/argon2';

const ARGON2_OPTIONS = {
  algorithm: 2 as Algorithm,
  version: 1 as Version,
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 1,
  outputLen: 32,
} satisfies Options;
const ARGON2_SALT_LENGTH = 16;

export interface PasswordVerification {
  readonly valid: boolean;
  readonly needsRehash: boolean;
}

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(encodedHash: string, password: string): Promise<PasswordVerification>;
}

export class Argon2PasswordHasher implements PasswordHasher {
  hash(password: string): Promise<string> {
    return hash(password, {
      ...ARGON2_OPTIONS,
      salt: crypto.getRandomValues(new Uint8Array(ARGON2_SALT_LENGTH)),
    });
  }

  async verify(encodedHash: string, password: string): Promise<PasswordVerification> {
    const valid = await verify(encodedHash, password);
    return { valid, needsRehash: valid && needsArgon2Rehash(encodedHash) };
  }
}

export function needsArgon2Rehash(encodedHash: string): boolean {
  const match = /^\$argon2id\$v=(\d+)\$m=(\d+),t=(\d+),p=(\d+)\$([^$]+)\$([^$]+)$/.exec(
    encodedHash,
  );
  if (match === null) return true;

  const [, version, memoryCost, timeCost, parallelism, encodedSalt, encodedOutput] = match;
  return (
    Number(version) !== 19 ||
    Number(memoryCost) < ARGON2_OPTIONS.memoryCost ||
    Number(timeCost) < ARGON2_OPTIONS.timeCost ||
    Number(parallelism) !== ARGON2_OPTIONS.parallelism ||
    decodedLength(encodedSalt ?? '') < ARGON2_SALT_LENGTH ||
    decodedLength(encodedOutput ?? '') < ARGON2_OPTIONS.outputLen
  );
}

function decodedLength(value: string): number {
  try {
    return Buffer.from(value, 'base64').byteLength;
  } catch {
    return 0;
  }
}
