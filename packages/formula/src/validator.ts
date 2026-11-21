import { err, ok, type Result } from '@rpg/contracts';
import {
  type CompiledFormula,
  FORBIDDEN_IDENTIFIERS,
  FORMULA_LIMITS,
  type FormulaAst,
  type FormulaFailure,
  type FormulaResultType,
  type FormulaSource,
  failure,
} from './model.ts';
import { parseFormula } from './parser.ts';

/**
 * Static validation (FR-008): what can be refused knowing only the formula. An identifier has no
 * type until a context supplies it, so it is compatible with anything here; the interpreter checks
 * it again at run time.
 */

/** The allow list (D-05). A `Map`, so no formula-controlled name ever reaches a property lookup. */
export const FORMULA_FUNCTIONS: ReadonlyMap<
  string,
  { readonly minArguments: number; readonly maxArguments: number }
> = new Map([['min', { minArguments: 2, maxArguments: FORMULA_LIMITS.functionArguments }]]);

interface Walk {
  operations: number;
  readonly names: Set<string>;
}

function isLiteralZero(node: FormulaAst): boolean {
  if (node.kind === 'number') return node.value === 0;
  return node.kind === 'negate' && isLiteralZero(node.operand);
}

function requireNumber(type: FormulaResultType, what: string): FormulaFailure | undefined {
  return type === 'boolean' ? failure('type_mismatch', `${what} needs a number.`) : undefined;
}

function walk(
  node: FormulaAst,
  depth: number,
  state: Walk,
): Result<FormulaResultType, FormulaFailure> {
  state.operations += 1;
  if (state.operations > FORMULA_LIMITS.operations) {
    return err(failure('limit_exceeded', 'The formula has too many operations.'));
  }
  if (depth > FORMULA_LIMITS.depth) {
    return err(failure('limit_exceeded', 'The formula is nested too deeply.'));
  }
  switch (node.kind) {
    case 'number':
      return ok('number');
    case 'boolean':
      return ok('boolean');
    case 'identifier':
      if (FORBIDDEN_IDENTIFIERS.has(node.name)) {
        return err(failure('forbidden_identifier', `The name ${node.name} is not allowed.`));
      }
      state.names.add(node.name);
      return ok('unknown');
    case 'negate': {
      const operand = walk(node.operand, depth + 1, state);
      if (!operand.ok) return operand;
      const mismatch = requireNumber(operand.value, 'Negation');
      return mismatch === undefined ? ok('number') : err(mismatch);
    }
    case 'arithmetic': {
      const left = walk(node.left, depth + 1, state);
      if (!left.ok) return left;
      const right = walk(node.right, depth + 1, state);
      if (!right.ok) return right;
      const mismatch =
        requireNumber(left.value, `Operator ${node.operator}`) ??
        requireNumber(right.value, `Operator ${node.operator}`);
      if (mismatch !== undefined) return err(mismatch);
      if (node.operator === '/' && isLiteralZero(node.right)) {
        return err(failure('division_by_zero', 'The divisor is zero.'));
      }
      return ok('number');
    }
    case 'compare': {
      const left = walk(node.left, depth + 1, state);
      if (!left.ok) return left;
      const right = walk(node.right, depth + 1, state);
      if (!right.ok) return right;
      if (node.operator === '==' || node.operator === '!=') {
        if (left.value !== 'unknown' && right.value !== 'unknown' && left.value !== right.value) {
          return err(failure('type_mismatch', `Operator ${node.operator} needs one type.`));
        }
        return ok('boolean');
      }
      const mismatch =
        requireNumber(left.value, `Operator ${node.operator}`) ??
        requireNumber(right.value, `Operator ${node.operator}`);
      return mismatch === undefined ? ok('boolean') : err(mismatch);
    }
    case 'call': {
      const allowed = FORMULA_FUNCTIONS.get(node.name);
      if (allowed === undefined) {
        return err(failure('unknown_function', `The function ${node.name} is not allowed.`));
      }
      if (node.args.length < allowed.minArguments || node.args.length > allowed.maxArguments) {
        return err(
          failure(
            'arity',
            `${node.name} takes ${allowed.minArguments} to ${allowed.maxArguments} arguments.`,
          ),
        );
      }
      for (const argument of node.args) {
        const type = walk(argument, depth + 1, state);
        if (!type.ok) return type;
        const mismatch = requireNumber(type.value, node.name);
        if (mismatch !== undefined) return err(mismatch);
      }
      return ok('number');
    }
    default:
      return err(failure('syntax', 'Unknown syntax node.'));
  }
}

export function validateFormula(ast: FormulaAst): Result<CompiledFormula, FormulaFailure> {
  const state: Walk = { operations: 0, names: new Set() };
  const type = walk(ast, 1, state);
  if (!type.ok) return type;
  return ok({ ast, dependencies: [...state.names].sort(), resultType: type.value });
}

export function compileFormula(source: FormulaSource): Result<CompiledFormula, FormulaFailure> {
  const ast = parseFormula(source);
  return ast.ok ? validateFormula(ast.value) : ast;
}

export function formulaDependencies(formula: CompiledFormula): readonly string[] {
  return formula.dependencies;
}
