/**
 * The formula language's shapes (`_techspec.md`). A formula reads a caller-supplied map and returns
 * a number or a boolean: there is no statement, no object, no text, and no way to name anything
 * outside the context.
 */

export type FormulaSource = string;
export type FormulaValue = number | boolean;
export type FormulaContext = Readonly<Record<string, unknown>>;

export type ArithmeticOperator = '+' | '-' | '*' | '/';
export type CompareOperator = '<' | '<=' | '>' | '>=' | '==' | '!=';

export type FormulaAst =
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'identifier'; readonly name: string }
  | { readonly kind: 'negate'; readonly operand: FormulaAst }
  | {
      readonly kind: 'arithmetic';
      readonly operator: ArithmeticOperator;
      readonly left: FormulaAst;
      readonly right: FormulaAst;
    }
  | {
      readonly kind: 'compare';
      readonly operator: CompareOperator;
      readonly left: FormulaAst;
      readonly right: FormulaAst;
    }
  | { readonly kind: 'call'; readonly name: string; readonly args: readonly FormulaAst[] };

export type FormulaResultType = 'number' | 'boolean' | 'unknown';

export interface CompiledFormula {
  readonly ast: FormulaAst;
  /** Every identifier the formula reads, sorted and unique. */
  readonly dependencies: readonly string[];
  /** `unknown` when the value is a bare identifier, typed only at run time. */
  readonly resultType: FormulaResultType;
}

export type FormulaFailureCode =
  | 'syntax'
  | 'unknown_function'
  | 'arity'
  | 'type_mismatch'
  | 'forbidden_identifier'
  | 'unknown_identifier'
  | 'invalid_context_value'
  | 'division_by_zero'
  | 'limit_exceeded';

/** A message names the formula's own identifiers and limits, never a context value (PRD privacy). */
export interface FormulaFailure {
  readonly code: FormulaFailureCode;
  readonly message: string;
  readonly position?: number;
}

/** D-08. Exceeding any of them is a typed failure, never a hang. */
export const FORMULA_LIMITS = {
  sourceLength: 500,
  depth: 32,
  operations: 256,
  functionArguments: 8,
  identifierLength: 64,
} as const;

/** Names that mean something to the host language; refused even though lookup could not reach them. */
export const FORBIDDEN_IDENTIFIERS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

export function failure(
  code: FormulaFailureCode,
  message: string,
  position?: number,
): FormulaFailure {
  return position === undefined ? { code, message } : { code, message, position };
}
