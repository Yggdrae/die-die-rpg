/**
 * Business failures as values (`docs/SPEC_GUIDELINE.md`, Code).
 *
 * For expected outcomes: a stale version, a denied permission, an invalid formula. Not for
 * programmer errors or infrastructure faults, which stay exceptions. Do not wrap trivial
 * functions in this mechanically.
 */
export type Ok<T> = { readonly ok: true; readonly value: T };
export type Err<E> = { readonly ok: false; readonly error: E };
export type Result<T, E> = Ok<T> | Err<E>;

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

export function err<E>(error: E): Err<E> {
  return { ok: false, error };
}

export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
  return result.ok;
}

export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
  return !result.ok;
}

/** Unwrap, or throw. Use in tests and at boundaries that have already checked. */
export function unwrap<T, E>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`unwrap on Err: ${JSON.stringify(result.error)}`);
  }
  return result.value;
}
