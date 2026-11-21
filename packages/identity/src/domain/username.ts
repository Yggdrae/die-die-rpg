import { err, ok, type Result } from '@rpg/contracts';

const ASCII_EDGE_WHITESPACE = /^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/g;
const USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{2,31}$/;

export interface NormalizedUsername {
  readonly display: string;
  readonly normalized: string;
}

export type UsernameError = 'invalid_username';

export function normalizeUsername(username: string): Result<NormalizedUsername, UsernameError> {
  const display = username.replace(ASCII_EDGE_WHITESPACE, '');
  if (!USERNAME_PATTERN.test(display)) {
    return err('invalid_username');
  }

  return ok({ display, normalized: asciiLowercase(display) });
}

function asciiLowercase(value: string): string {
  return value.replace(/[A-Z]/g, (character) => String.fromCharCode(character.charCodeAt(0) + 32));
}
