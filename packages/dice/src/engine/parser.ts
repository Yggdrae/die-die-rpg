import { err, ok, type Result } from '@rpg/contracts';
import {
  DIE_TYPES,
  type DieType,
  type ParsedTerm,
  ROLL_LIMITS,
  type RollExpression,
  type RollParseCode,
  type RollParseFailure,
  type SuccessOperator,
} from './model.ts';

/**
 * Dice notation to a parsed expression (`_techspec.md` "Grammar"). Reject rather than guess: there is
 * no default count, no case folding, no space inside a dice term, and a name that could be misread as
 * notation is refused (D-06). The scan is linear in the source, which is length-limited first.
 */

const RESERVED = /^(?:d\d+|dF|success|k[hl]\d*|__proto__|constructor|prototype)$/;
const SUCCESS_OPERATORS: readonly SuccessOperator[] = ['>=', '<=', '>', '<', '='];

class Stop {
  constructor(readonly reason: RollParseFailure) {}
}

function stop(code: RollParseCode, message: string, position: number): never {
  throw new Stop({ code, message, position });
}

function isDigit(character: string | undefined): boolean {
  return character !== undefined && character >= '0' && character <= '9';
}

function isNameCharacter(character: string | undefined): boolean {
  return (
    character !== undefined &&
    ((character >= 'a' && character <= 'z') ||
      (character >= 'A' && character <= 'Z') ||
      character === '_' ||
      isDigit(character))
  );
}

class Parser {
  #index = 0;

  constructor(private readonly source: string) {}

  parse(): RollExpression {
    const terms: ParsedTerm[] = [];
    let sign: 1 | -1 = 1;
    for (;;) {
      terms.push(this.#term(sign));
      if (terms.length > ROLL_LIMITS.terms) {
        stop('out_of_bounds', 'The expression has too many terms.', this.#index);
      }
      const beforeSpaces = this.#index;
      this.#spaces();
      const operator = this.source[this.#index];
      if (operator === '+' || operator === '-') {
        sign = operator === '+' ? 1 : -1;
        this.#index += 1;
        this.#spaces();
        continue;
      }
      if (this.#index === this.source.length) {
        if (beforeSpaces !== this.#index) {
          stop('syntax', 'The expression has trailing spaces.', beforeSpaces);
        }
        return this.#finish(terms);
      }
      if (this.source.startsWith('success', this.#index) && this.#index > beforeSpaces) {
        return this.#finish(terms, this.#success(terms));
      }
      stop('syntax', 'Unexpected text in the expression.', this.#index);
    }
  }

  #spaces(): void {
    while (this.source[this.#index] === ' ') this.#index += 1;
  }

  #integer(): number {
    const start = this.#index;
    while (isDigit(this.source[this.#index])) this.#index += 1;
    const text = this.source.slice(start, this.#index);
    if (text.length === 0) stop('syntax', 'Expected a number.', start);
    if (text.length > 1 && text[0] === '0') {
      stop('syntax', 'A number has no leading zero.', start);
    }
    const value = Number(text);
    if (value > ROLL_LIMITS.magnitude) stop('out_of_bounds', 'A number is past the limit.', start);
    return value;
  }

  #term(sign: 1 | -1): ParsedTerm {
    const start = this.#index;
    const character = this.source[start];
    if (isDigit(character)) {
      const value = this.#integer();
      if (this.source[this.#index] !== 'd') return { kind: 'modifier', sign, value };
      return this.#dice(sign, value, start);
    }
    if (character !== undefined && isNameCharacter(character)) {
      while (isNameCharacter(this.source[this.#index])) this.#index += 1;
      const name = this.source.slice(start, this.#index);
      if (name.length > ROLL_LIMITS.nameLength) {
        stop('out_of_bounds', 'A name is past the length limit.', start);
      }
      if (RESERVED.test(name)) {
        // `d20` with no count is notation written wrong, in the leading position a reader expects.
        stop(
          start === 0 && /^d/.test(name) ? 'syntax' : 'reserved_name',
          `The name ${name} is reserved.`,
          start,
        );
      }
      return { kind: 'input', sign, name };
    }
    return stop('syntax', 'Expected dice, a number, or a name.', start);
  }

  #dice(sign: 1 | -1, count: number, start: number): ParsedTerm {
    if (count < 1) stop('out_of_bounds', 'A dice term rolls at least one die.', start);
    if (count > ROLL_LIMITS.totalDice) {
      stop('out_of_bounds', 'The expression rolls too many dice.', start);
    }
    this.#index += 1;
    const dieStart = this.#index;
    let die: string;
    if (this.source[this.#index] === 'F') {
      this.#index += 1;
      die = 'dF';
    } else {
      while (isDigit(this.source[this.#index])) this.#index += 1;
      die = `d${this.source.slice(dieStart, this.#index)}`;
    }
    if (die === 'd') stop('syntax', 'Expected a die type.', dieStart);
    if (!(DIE_TYPES as readonly string[]).includes(die)) {
      stop('unknown_die', `The die ${die} is not supported.`, dieStart);
    }
    const next = this.source[this.#index];
    if (next !== 'k') {
      if (isNameCharacter(next)) stop('syntax', 'Unexpected text after the die.', this.#index);
      return { kind: 'dice', sign, count, die: die as DieType };
    }
    const mode = this.source[this.#index + 1];
    if (mode !== 'h' && mode !== 'l') stop('syntax', 'Expected kh or kl.', this.#index);
    this.#index += 2;
    const keepStart = this.#index;
    const keep = this.#integer();
    if (keep < 1 || keep > count) {
      stop('out_of_bounds', 'A term keeps between one die and all of them.', keepStart);
    }
    if (isNameCharacter(this.source[this.#index])) {
      stop('syntax', 'Unexpected text after the keep.', this.#index);
    }
    return {
      kind: 'dice',
      sign,
      count,
      die: die as DieType,
      keep: { mode: mode === 'h' ? 'highest' : 'lowest', count: keep },
    };
  }

  #success(terms: readonly ParsedTerm[]): NonNullable<RollExpression['success']> {
    const start = this.#index;
    this.#index += 'success'.length;
    const operator = SUCCESS_OPERATORS.find((candidate) =>
      this.source.startsWith(candidate, this.#index),
    );
    if (operator === undefined) stop('syntax', 'Expected a comparison.', this.#index);
    this.#index += operator.length;
    const threshold = this.#integer();
    if (this.#index !== this.source.length) {
      stop('syntax', 'Unexpected text after the threshold.', this.#index);
    }
    const [only] = terms;
    if (terms.length !== 1 || only?.kind !== 'dice' || only.sign !== 1) {
      stop('invalid_success', 'A success clause applies to exactly one dice term.', start);
    }
    return { operator, threshold };
  }

  #finish(terms: readonly ParsedTerm[], success?: RollExpression['success']): RollExpression {
    const dice = terms.filter((term) => term.kind === 'dice');
    if (dice.length === 0) stop('no_dice', 'The expression rolls no dice.', 0);
    if (dice.reduce((total, term) => total + term.count, 0) > ROLL_LIMITS.totalDice) {
      stop('out_of_bounds', 'The expression rolls too many dice.', 0);
    }
    const inputs = [
      ...new Set(terms.flatMap((term) => (term.kind === 'input' ? [term.name] : []))),
    ].sort();
    return {
      source: this.source,
      terms,
      inputs,
      ...(success === undefined ? {} : { success }),
    };
  }
}

export function parseRoll(source: string): Result<RollExpression, RollParseFailure> {
  if (typeof source !== 'string' || source.length === 0) {
    return err({ code: 'syntax', message: 'An expression is non-empty text.' });
  }
  if (source.length > ROLL_LIMITS.expressionLength) {
    return err({ code: 'out_of_bounds', message: 'The expression is past the length limit.' });
  }
  try {
    return ok(new Parser(source).parse());
  } catch (error) {
    if (error instanceof Stop) return err(error.reason);
    throw error;
  }
}

/** `ExpressionValidators.dice`: an error message, or `undefined` when the source is valid. */
export function checkDiceSource(source: string): string | undefined {
  const parsed = parseRoll(source);
  return parsed.ok ? undefined : `${parsed.error.code}: ${parsed.error.message}`;
}
