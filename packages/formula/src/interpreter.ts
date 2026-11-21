import { err, ok, type Result } from '@rpg/contracts';
import {
  type CompiledFormula,
  FORBIDDEN_IDENTIFIERS,
  FORMULA_LIMITS,
  type FormulaAst,
  type FormulaContext,
  type FormulaFailure,
  type FormulaValue,
  failure,
} from './model.ts';
import { FORMULA_FUNCTIONS } from './validator.ts';

/**
 * The restricted interpreter: the security boundary (`PRD.md` s.75). It trusts nothing it receives,
 * because a caller can pass any tree: node kinds, the function allow list, types, depth, and the
 * operation count are checked again here. Every path terminates, since no node runs twice and a
 * cyclic tree hits the depth limit.
 */

const OVERFLOW = failure('limit_exceeded', 'A value is past the safe integer range.');

function canonical(value: number): number {
  return value === 0 ? 0 : value;
}

/** D-03: rounds toward negative infinity, exactly. `a % b` is exact, so `a - r` divides cleanly. */
function floorDivide(left: number, right: number): number {
  const remainder = left % right;
  const adjusted = remainder !== 0 && remainder < 0 !== right < 0 ? remainder + right : remainder;
  return (left - adjusted) / right;
}

/** Reads an own data property only: no accessor runs, and no prototype is consulted. */
function readContext(context: FormulaContext, name: string): Result<FormulaValue, FormulaFailure> {
  if (FORBIDDEN_IDENTIFIERS.has(name)) {
    return err(failure('forbidden_identifier', `The name ${name} is not allowed.`));
  }
  const descriptor = Object.getOwnPropertyDescriptor(context, name);
  if (descriptor === undefined) {
    return err(failure('unknown_identifier', `The name ${name} is not in the context.`));
  }
  if (!('value' in descriptor)) {
    return err(failure('invalid_context_value', `The value of ${name} is not plain data.`));
  }
  const value: unknown = descriptor.value;
  if (typeof value === 'boolean') return ok(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return ok(canonical(value));
  return err(failure('invalid_context_value', `The value of ${name} is not a whole number.`));
}

class Interpreter {
  #operations = 0;

  constructor(private readonly context: FormulaContext) {}

  run(node: FormulaAst, depth: number): Result<FormulaValue, FormulaFailure> {
    this.#operations += 1;
    if (this.#operations > FORMULA_LIMITS.operations) {
      return err(failure('limit_exceeded', 'The formula has too many operations.'));
    }
    if (depth > FORMULA_LIMITS.depth) {
      return err(failure('limit_exceeded', 'The formula is nested too deeply.'));
    }
    switch (node?.kind) {
      case 'number':
        return typeof node.value === 'number' && Number.isSafeInteger(node.value)
          ? ok(canonical(node.value))
          : err(failure('type_mismatch', 'A number literal is not a whole number.'));
      case 'boolean':
        return typeof node.value === 'boolean'
          ? ok(node.value)
          : err(failure('type_mismatch', 'A boolean literal is not a boolean.'));
      case 'identifier':
        return readContext(this.context, node.name);
      case 'negate': {
        const operand = this.#number(node.operand, depth, 'Negation');
        return operand.ok ? ok(canonical(-operand.value)) : operand;
      }
      case 'arithmetic':
        return this.#arithmetic(node, depth);
      case 'compare':
        return this.#compare(node, depth);
      case 'call':
        return this.#call(node, depth);
      default:
        return err(failure('syntax', 'Unknown syntax node.'));
    }
  }

  #number(node: FormulaAst, depth: number, what: string): Result<number, FormulaFailure> {
    const value = this.run(node, depth + 1);
    if (!value.ok) return value;
    return typeof value.value === 'number'
      ? ok(value.value)
      : err(failure('type_mismatch', `${what} needs a number.`));
  }

  #arithmetic(
    node: Extract<FormulaAst, { kind: 'arithmetic' }>,
    depth: number,
  ): Result<FormulaValue, FormulaFailure> {
    const left = this.#number(node.left, depth, `Operator ${node.operator}`);
    if (!left.ok) return left;
    const right = this.#number(node.right, depth, `Operator ${node.operator}`);
    if (!right.ok) return right;
    let value: number;
    switch (node.operator) {
      case '+':
        value = left.value + right.value;
        break;
      case '-':
        value = left.value - right.value;
        break;
      case '*':
        value = left.value * right.value;
        break;
      case '/':
        if (right.value === 0) return err(failure('division_by_zero', 'The divisor is zero.'));
        value = floorDivide(left.value, right.value);
        break;
      default:
        return err(failure('syntax', 'Unknown operator.'));
    }
    return Number.isSafeInteger(value) ? ok(canonical(value)) : err(OVERFLOW);
  }

  #compare(
    node: Extract<FormulaAst, { kind: 'compare' }>,
    depth: number,
  ): Result<FormulaValue, FormulaFailure> {
    const left = this.run(node.left, depth + 1);
    if (!left.ok) return left;
    const right = this.run(node.right, depth + 1);
    if (!right.ok) return right;
    if (node.operator === '==' || node.operator === '!=') {
      if (typeof left.value !== typeof right.value) {
        return err(failure('type_mismatch', `Operator ${node.operator} needs one type.`));
      }
      return ok(node.operator === '==' ? left.value === right.value : left.value !== right.value);
    }
    if (typeof left.value !== 'number' || typeof right.value !== 'number') {
      return err(failure('type_mismatch', `Operator ${node.operator} needs a number.`));
    }
    switch (node.operator) {
      case '<':
        return ok(left.value < right.value);
      case '<=':
        return ok(left.value <= right.value);
      case '>':
        return ok(left.value > right.value);
      case '>=':
        return ok(left.value >= right.value);
      default:
        return err(failure('syntax', 'Unknown operator.'));
    }
  }

  #call(
    node: Extract<FormulaAst, { kind: 'call' }>,
    depth: number,
  ): Result<FormulaValue, FormulaFailure> {
    const allowed = FORMULA_FUNCTIONS.get(node.name);
    if (allowed === undefined) {
      return err(failure('unknown_function', 'The function is not allowed.'));
    }
    if (
      !Array.isArray(node.args) ||
      node.args.length < allowed.minArguments ||
      node.args.length > allowed.maxArguments
    ) {
      return err(failure('arity', `${node.name} has the wrong number of arguments.`));
    }
    let smallest: number | undefined;
    for (const argument of node.args) {
      const value = this.#number(argument, depth, node.name);
      if (!value.ok) return value;
      smallest = smallest === undefined || value.value < smallest ? value.value : smallest;
    }
    return ok(smallest as number);
  }
}

function isCompiled(formula: CompiledFormula | FormulaAst): formula is CompiledFormula {
  return 'ast' in formula;
}

/** Same source and same context give the same result on every platform (FR-007). */
export function evaluateFormula(
  formula: CompiledFormula | FormulaAst,
  context: FormulaContext,
): Result<FormulaValue, FormulaFailure> {
  if (formula === null || typeof formula !== 'object') {
    return err(failure('syntax', 'Unknown syntax node.'));
  }
  return new Interpreter(context).run(isCompiled(formula) ? formula.ast : formula, 1);
}
