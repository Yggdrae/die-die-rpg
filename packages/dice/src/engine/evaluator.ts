import { err, ok, type Result } from '@rpg/contracts';
import {
  type DieType,
  type ParsedTerm,
  type RandomSource,
  ROLL_LIMITS,
  type RollEvaluationFailure,
  type RollExpression,
  type RolledDie,
  type RollInputs,
  type RollResult,
  type RollTerm,
  type SuccessOperator,
} from './model.ts';
import { parseRoll } from './parser.ts';

/**
 * Evaluates a parsed expression (D-03, D-04). Integers, addition, and subtraction only, so no rounding
 * rule exists. Dice roll in source order, and a keep breaks ties by the earlier die, so the same faces
 * always give the same kept set on every client.
 */

/** Number of faces of a die, and the value of its lowest face. */
function dieShape(die: DieType): { readonly faces: number; readonly lowest: number } {
  return die === 'dF' ? { faces: 3, lowest: -1 } : { faces: Number(die.slice(1)), lowest: 1 };
}

/** Reads an own data property only: no accessor runs, and no prototype is consulted. */
function readInput(inputs: RollInputs, name: string): Result<number, RollEvaluationFailure> {
  const descriptor = Object.getOwnPropertyDescriptor(inputs, name);
  if (descriptor === undefined) {
    return err({ code: 'missing_input', name, message: `No value was supplied for ${name}.` });
  }
  const value: unknown = 'value' in descriptor ? descriptor.value : undefined;
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    Math.abs(value) > ROLL_LIMITS.magnitude
  ) {
    return err({
      code: 'invalid_input',
      name,
      message: `The value of ${name} is not a whole number in range.`,
    });
  }
  return ok(value === 0 ? 0 : value);
}

function keptFlags(values: readonly number[], keep: ParsedKeep): readonly boolean[] {
  if (keep === undefined) return values.map(() => true);
  const order = values
    .map((value, index) => ({ value, index }))
    .sort((left, right) =>
      left.value === right.value
        ? left.index - right.index
        : keep.mode === 'highest'
          ? right.value - left.value
          : left.value - right.value,
    );
  const kept = new Set(order.slice(0, keep.count).map((entry) => entry.index));
  return values.map((_value, index) => kept.has(index));
}

type ParsedKeep = Extract<ParsedTerm, { kind: 'dice' }>['keep'];

function meets(value: number, operator: SuccessOperator, threshold: number): boolean {
  switch (operator) {
    case '>=':
      return value >= threshold;
    case '>':
      return value > threshold;
    case '<=':
      return value <= threshold;
    case '<':
      return value < threshold;
    default:
      return value === threshold;
  }
}

/** The whole result from given faces; `rollFace` is the only place randomness can enter. */
function compute(
  expression: RollExpression,
  inputs: RollInputs,
  rollFace: (die: DieType) => number,
): Result<RollResult, RollEvaluationFailure> {
  // Inputs first: a missing value rolls no dice.
  const resolved = new Map<string, number>();
  for (const name of expression.inputs) {
    const value = readInput(inputs, name);
    if (!value.ok) return value;
    resolved.set(name, value.value);
  }
  const terms: RollTerm[] = [];
  let natural = 0;
  let modifiers = 0;
  let successes = 0;
  for (const term of expression.terms) {
    if (term.kind === 'modifier') {
      terms.push({ kind: 'modifier', sign: term.sign, value: term.value });
      modifiers += term.sign * term.value;
      continue;
    }
    if (term.kind === 'input') {
      const value = resolved.get(term.name) as number;
      terms.push({ kind: 'input', sign: term.sign, name: term.name, value });
      modifiers += term.sign * value;
      continue;
    }
    const values = Array.from({ length: term.count }, () => rollFace(term.die));
    const kept = keptFlags(values, term.keep);
    let sum = 0;
    const faces: RolledDie[] = values.map((value, index) => {
      const isKept = kept[index] === true;
      if (isKept) sum += value;
      if (expression.success === undefined) return { value, kept: isKept };
      const success =
        isKept && meets(value, expression.success.operator, expression.success.threshold);
      if (success) successes += 1;
      return { value, kept: isKept, success };
    });
    const subtotal = term.sign * sum + 0;
    terms.push({ kind: 'dice', sign: term.sign, die: term.die, faces, subtotal });
    natural += subtotal;
  }
  if (expression.success !== undefined) {
    return ok({ terms, natural: successes, modified: successes, successes });
  }
  return ok({ terms, natural: natural + 0, modified: natural + modifiers + 0 });
}

export function evaluateRoll(
  expression: RollExpression,
  inputs: RollInputs,
  random: RandomSource,
): Result<RollResult, RollEvaluationFailure> {
  return compute(expression, inputs, (die) => {
    const { faces, lowest } = dieShape(die);
    return random.nextInt(faces) + lowest;
  });
}

/** Stable text of a result: key order is fixed by construction here, never by the input object. */
function canonical(result: RollResult): string {
  return JSON.stringify({
    natural: result.natural,
    modified: result.modified,
    successes: result.successes,
    terms: result.terms.map((term) =>
      term.kind === 'dice'
        ? {
            kind: term.kind,
            sign: term.sign,
            die: term.die,
            faces: term.faces.map((face) => [face.value, face.kept, face.success]),
            subtotal: term.subtotal,
          }
        : term.kind === 'input'
          ? { kind: term.kind, sign: term.sign, name: term.name, value: term.value }
          : { kind: term.kind, sign: term.sign, value: term.value },
    ),
  });
}

class ReplayRefused {}

/**
 * Whether a recorded result reproduces itself from its own faces (D-14). Refuses any changed total,
 * flag, or term, and any face outside its die. It proves a record is faithful, not that it was fair.
 */
export function replayRoll(source: string, inputs: RollInputs, result: RollResult): boolean {
  const parsed = parseRoll(source);
  if (!parsed.ok || result === null || typeof result !== 'object') return false;
  if (!Array.isArray(result.terms)) return false;
  const recorded: number[] = [];
  for (const term of result.terms) {
    if (term?.kind !== 'dice') continue;
    if (!Array.isArray(term.faces)) return false;
    for (const face of term.faces) recorded.push(face?.value);
  }
  let next = 0;
  try {
    const replayed = compute(parsed.value, inputs, (die) => {
      const value = recorded[next];
      next += 1;
      const { faces, lowest } = dieShape(die);
      if (
        typeof value !== 'number' ||
        !Number.isInteger(value) ||
        value < lowest ||
        value >= lowest + faces
      ) {
        throw new ReplayRefused();
      }
      return value;
    });
    return (
      replayed.ok && next === recorded.length && canonical(replayed.value) === canonical(result)
    );
  } catch (error) {
    if (error instanceof ReplayRefused) return false;
    throw error;
  }
}
