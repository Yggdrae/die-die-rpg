import { err, ok, type Result } from '@rpg/contracts';

export type PasswordError = 'invalid_password';

export function validatePassword(password: string): Result<string, PasswordError> {
  const codePoints = [...password].length;
  const utf8Bytes = new TextEncoder().encode(password).byteLength;
  if (codePoints < 15 || codePoints > 128 || utf8Bytes > 512) {
    return err('invalid_password');
  }
  return ok(password);
}
