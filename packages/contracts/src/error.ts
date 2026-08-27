import { type Static, Type } from '@sinclair/typebox';

/**
 * The one HTTP error shape (`docs/SPEC_GUIDELINE.md`, API and Validation).
 *
 * `message` is safe to show a user. `details` carries structured, non-sensitive context
 * such as a validation field path. Neither may leak an internal detail, and neither may
 * reveal whether a hidden record exists: a denial and a miss must be indistinguishable
 * (feature 04 FR-009).
 */
export const ApiError = Type.Object(
  {
    code: Type.String({ minLength: 1 }),
    message: Type.String({ minLength: 1 }),
    details: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { $id: 'ApiError' },
);
export type ApiError = Static<typeof ApiError>;

/**
 * Shared error codes. A feature adds its own; these are the ones more than one feature
 * needs to produce or recognize.
 */
export const ErrorCode = {
  VALIDATION_FAILED: 'validation_failed',
  UNAUTHENTICATED: 'unauthenticated',
  NOT_FOUND_OR_FORBIDDEN: 'not_found_or_forbidden',
  VERSION_CONFLICT: 'version_conflict',
  LIMIT_EXCEEDED: 'limit_exceeded',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export function apiError(
  code: string,
  message: string,
  details?: Record<string, unknown>,
): ApiError {
  return details === undefined ? { code, message } : { code, message, details };
}
