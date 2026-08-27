import type { Static, TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { ApiError } from './error.ts';
import { apiError, ErrorCode } from './error.ts';
import { err, ok, type Result } from './result.ts';

/**
 * Validation helpers, so a feature package validates without depending on TypeBox
 * directly and without each one inventing its own error mapping.
 *
 * Still validators, not behavior. Nothing here decides anything.
 */

export function check<T extends TSchema>(schema: T, value: unknown): value is Static<T> {
  return Value.Check(schema, value);
}

export interface ValidationIssue {
  readonly path: string;
  readonly message: string;
}

export function issues<T extends TSchema>(schema: T, value: unknown): ValidationIssue[] {
  return [...Value.Errors(schema, value)].map((error) => ({
    path: error.path,
    message: error.message,
  }));
}

/**
 * Validate at a boundary. Invalid data never enters the domain silently
 * (`PRD.md` s.16, s.75).
 */
export function parse<T extends TSchema>(schema: T, value: unknown): Result<Static<T>, ApiError> {
  const found = issues(schema, value);
  if (found.length > 0) {
    return err(
      apiError(ErrorCode.VALIDATION_FAILED, 'Payload failed schema validation.', {
        issues: found,
      }),
    );
  }
  return ok(value as Static<T>);
}
