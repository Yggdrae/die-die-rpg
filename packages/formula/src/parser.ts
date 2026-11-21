import { err, ok, type Result } from '@rpg/contracts';
import {
  type ArithmeticOperator,
  type CompareOperator,
  FORMULA_LIMITS,
  type FormulaAst,
  type FormulaFailure,
  type FormulaSource,
  failure,
} from './model.ts';

/**
 * Formula source to AST (`_techspec.md` "Pipeline"). Hand-written recursive descent over a small
 * token stream, with depth and operation limits checked while descending, so hostile nesting is a
 * typed failure and never a stack overflow.
 */

type Token =
  | { readonly type: 'number'; readonly value: number; readonly position: number }
  | { readonly type: 'name'; readonly value: string; readonly position: number }
  | { readonly type: 'symbol'; readonly value: string; readonly position: number }
  | { readonly type: 'end'; readonly position: number };

const SYMBOLS = ['<=', '>=', '==', '!=', '<', '>', '+', '-', '*', '/', '(', ')', ','] as const;
const COMPARE: ReadonlySet<string> = new Set(['<', '<=', '>', '>=', '==', '!=']);

function isDigit(character: string | undefined): boolean {
  return character !== undefined && character >= '0' && character <= '9';
}

function isNameStart(character: string | undefined): boolean {
  return (
    character !== undefined &&
    ((character >= 'a' && character <= 'z') ||
      (character >= 'A' && character <= 'Z') ||
      character === '_')
  );
}

function tokenize(source: string): Result<readonly Token[], FormulaFailure> {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const character = source[index];
    if (character === ' ' || character === '\t' || character === '\n' || character === '\r') {
      index += 1;
      continue;
    }
    if (isDigit(character)) {
      const start = index;
      while (isDigit(source[index])) index += 1;
      if (isNameStart(source[index]) || source[index] === '.') {
        return err(failure('syntax', 'A number is whole digits only.', start));
      }
      const text = source.slice(start, index);
      const value = Number(text);
      if (!Number.isSafeInteger(value)) {
        return err(failure('limit_exceeded', 'A number is past the safe integer range.', start));
      }
      tokens.push({ type: 'number', value, position: start });
      continue;
    }
    if (isNameStart(character)) {
      const start = index;
      while (isNameStart(source[index]) || isDigit(source[index])) index += 1;
      const value = source.slice(start, index);
      if (value.length > FORMULA_LIMITS.identifierLength) {
        return err(failure('limit_exceeded', 'A name is past the length limit.', start));
      }
      tokens.push({ type: 'name', value, position: start });
      continue;
    }
    const symbol = SYMBOLS.find((candidate) => source.startsWith(candidate, index));
    if (symbol === undefined) {
      return err(failure('syntax', 'Unexpected character.', index));
    }
    tokens.push({ type: 'symbol', value: symbol, position: index });
    index += symbol.length;
  }
  tokens.push({ type: 'end', position: source.length });
  return ok(tokens);
}

/** Thrown only inside this file, so one failure unwinds the descent; never reaches a caller. */
class ParseStop {
  constructor(readonly reason: FormulaFailure) {}
}

class Parser {
  #index = 0;
  #operations = 0;

  constructor(private readonly tokens: readonly Token[]) {}

  parse(): FormulaAst {
    const ast = this.#comparison(1);
    const next = this.#peek();
    if (next.type !== 'end') this.#stop('Unexpected text after the formula.', next.position);
    return ast;
  }

  #peek(): Token {
    return this.tokens[this.#index] as Token;
  }

  #stop(message: string, position: number): never {
    throw new ParseStop(failure('syntax', message, position));
  }

  #symbol(value: string): boolean {
    const next = this.#peek();
    return next.type === 'symbol' && next.value === value;
  }

  #node(depth: number, position: number): void {
    this.#operations += 1;
    if (this.#operations > FORMULA_LIMITS.operations) {
      throw new ParseStop(
        failure('limit_exceeded', 'The formula has too many operations.', position),
      );
    }
    if (depth > FORMULA_LIMITS.depth) {
      throw new ParseStop(failure('limit_exceeded', 'The formula is nested too deeply.', position));
    }
  }

  #comparison(depth: number): FormulaAst {
    const left = this.#additive(depth + 1);
    const next = this.#peek();
    if (next.type !== 'symbol' || !COMPARE.has(next.value)) return left;
    this.#index += 1;
    this.#node(depth, next.position);
    const right = this.#additive(depth + 1);
    const after = this.#peek();
    if (after.type === 'symbol' && COMPARE.has(after.value)) {
      this.#stop('Comparisons do not chain; use parentheses.', after.position);
    }
    return { kind: 'compare', operator: next.value as CompareOperator, left, right };
  }

  /**
   * A sum is a left-deep tree, so each further term is one level deeper; the depth limit applies
   * to the tree the interpreter will walk, not to how the source happens to read.
   */
  #additive(depth: number): FormulaAst {
    let left = this.#multiplicative(depth + 1);
    let chain = depth;
    while (this.#symbol('+') || this.#symbol('-')) {
      const operator = this.#peek() as Extract<Token, { type: 'symbol' }>;
      this.#index += 1;
      chain += 1;
      this.#node(chain, operator.position);
      const right = this.#multiplicative(depth + 1);
      left = { kind: 'arithmetic', operator: operator.value as ArithmeticOperator, left, right };
    }
    return left;
  }

  #multiplicative(depth: number): FormulaAst {
    let left = this.#unary(depth + 1);
    let chain = depth;
    while (this.#symbol('*') || this.#symbol('/')) {
      const operator = this.#peek() as Extract<Token, { type: 'symbol' }>;
      this.#index += 1;
      chain += 1;
      this.#node(chain, operator.position);
      const right = this.#unary(depth + 1);
      left = { kind: 'arithmetic', operator: operator.value as ArithmeticOperator, left, right };
    }
    return left;
  }

  #unary(depth: number): FormulaAst {
    if (this.#symbol('-')) {
      const { position } = this.#peek();
      this.#index += 1;
      this.#node(depth, position);
      return { kind: 'negate', operand: this.#unary(depth + 1) };
    }
    return this.#primary(depth);
  }

  #primary(depth: number): FormulaAst {
    const token = this.#peek();
    this.#node(depth, token.position);
    if (token.type === 'number') {
      this.#index += 1;
      return { kind: 'number', value: token.value };
    }
    if (token.type === 'name') {
      this.#index += 1;
      if (this.#symbol('(')) return this.#call(token.value, depth);
      if (token.value === 'true' || token.value === 'false') {
        return { kind: 'boolean', value: token.value === 'true' };
      }
      return { kind: 'identifier', name: token.value };
    }
    if (token.type === 'symbol' && token.value === '(') {
      this.#index += 1;
      const inner = this.#comparison(depth + 1);
      if (!this.#symbol(')')) this.#stop('Missing closing parenthesis.', this.#peek().position);
      this.#index += 1;
      return inner;
    }
    return this.#stop('Expected a value.', token.position);
  }

  #call(name: string, depth: number): FormulaAst {
    this.#index += 1;
    const args: FormulaAst[] = [];
    if (this.#symbol(')')) {
      this.#index += 1;
      return { kind: 'call', name, args };
    }
    for (;;) {
      args.push(this.#comparison(depth + 1));
      if (this.#symbol(',')) {
        this.#index += 1;
        continue;
      }
      if (this.#symbol(')')) {
        this.#index += 1;
        return { kind: 'call', name, args };
      }
      this.#stop('Expected a comma or a closing parenthesis.', this.#peek().position);
    }
  }
}

export function parseFormula(source: FormulaSource): Result<FormulaAst, FormulaFailure> {
  if (typeof source !== 'string') return err(failure('syntax', 'A formula is text.'));
  if (source.length > FORMULA_LIMITS.sourceLength) {
    return err(failure('limit_exceeded', 'The formula is past the length limit.'));
  }
  const tokens = tokenize(source);
  if (!tokens.ok) return tokens;
  try {
    return ok(new Parser(tokens.value).parse());
  } catch (error) {
    if (error instanceof ParseStop) return err(error.reason);
    throw error;
  }
}
