import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROLL_VECTORS } from './determinism-vectors.ts';
import {
  checkDiceSource,
  cryptoRandom,
  DIE_TYPES,
  evaluateRoll,
  parseRoll,
  type RandomSource,
  ROLL_LIMITS,
  type RollInputs,
  type RollResult,
  replayRoll,
  seededRandom,
} from './index.ts';

function roll(source: string, inputs: RollInputs = {}, random = seededRandom(42)): RollResult {
  const parsed = parseRoll(source);
  if (!parsed.ok) throw new Error(`${source}: ${parsed.error.message}`);
  const result = evaluateRoll(parsed.value, inputs, random);
  if (!result.ok) throw new Error(`${source}: ${result.error.message}`);
  return result.value;
}

/** A source that yields the given zero-based draws, for exact assertions. */
function draws(...values: readonly number[]): RandomSource {
  let index = 0;
  return {
    nextInt() {
      const value = values[index];
      index += 1;
      if (value === undefined) throw new Error('no draw left');
      return value;
    },
  };
}

function dice(result: RollResult) {
  return result.terms.flatMap((term) => (term.kind === 'dice' ? term.faces : []));
}

describe('notation', () => {
  test('1d20 is one die, natural equals modified', () => {
    const result = roll('1d20', {}, draws(12));
    expect(result).toEqual({
      terms: [
        { kind: 'dice', sign: 1, die: 'd20', faces: [{ value: 13, kept: true }], subtotal: 13 },
      ],
      natural: 13,
      modified: 13,
    });
  });

  test('2d6+3 keeps both dice and applies the modifier to modified only', () => {
    const result = roll('2d6+3', {}, draws(0, 5));
    expect(result.natural).toBe(7);
    expect(result.modified).toBe(10);
    expect(result.terms[1]).toEqual({ kind: 'modifier', sign: 1, value: 3 });
  });

  test('4d6kh3 keeps the highest three and reports the drop', () => {
    const result = roll('4d6kh3', {}, draws(0, 5, 2, 3));
    expect(dice(result)).toEqual([
      { value: 1, kept: false },
      { value: 6, kept: true },
      { value: 3, kept: true },
      { value: 4, kept: true },
    ]);
    expect(result.natural).toBe(13);
  });

  test('kl keeps the lowest', () => {
    const result = roll('4d6kl1', {}, draws(3, 0, 5, 2));
    expect(result.natural).toBe(1);
    expect(dice(result).filter((die) => die.kept)).toEqual([{ value: 1, kept: true }]);
  });

  test('a keep breaks ties by the earlier die', () => {
    const high = roll('3d6kh1', {}, draws(4, 4, 4));
    expect(dice(high).map((die) => die.kept)).toEqual([true, false, false]);
    const low = roll('3d6kl2', {}, draws(1, 1, 1));
    expect(dice(low).map((die) => die.kept)).toEqual([true, true, false]);
  });

  test('a named input is a modifier the caller resolves', () => {
    const result = roll('1d20+ATTRIBUTE_A', { ATTRIBUTE_A: 2 }, draws(9));
    expect(result.natural).toBe(10);
    expect(result.modified).toBe(12);
    expect(result.terms[1]).toEqual({ kind: 'input', sign: 1, name: 'ATTRIBUTE_A', value: 2 });
  });

  test('4dF ranges from -4 to 4 and reads a skill', () => {
    const result = roll('4dF + skill', { skill: 3 }, draws(0, 1, 2, 2));
    expect(dice(result).map((die) => die.value)).toEqual([-1, 0, 1, 1]);
    expect(result.natural).toBe(1);
    expect(result.modified).toBe(4);
  });

  test('a success clause counts dice meeting the threshold', () => {
    const result = roll('6d6 success>=6', {}, draws(5, 5, 0, 1, 2, 3));
    expect(result.natural).toBe(2);
    expect(result.modified).toBe(2);
    expect(result.successes).toBe(2);
    expect(dice(result).map((die) => die.success)).toEqual([
      true,
      true,
      false,
      false,
      false,
      false,
    ]);
  });

  test.each([
    ['>', 1],
    ['<=', 3],
    ['<', 2],
    ['=', 1],
  ])('faces 1 to 4 with success%s3 count %i', (operator, count) => {
    const result = roll(`4d6 success${operator}3`, {}, draws(0, 1, 2, 3));
    expect(result.successes).toBe(count);
  });

  test('only kept dice can succeed', () => {
    const result = roll('2d6kl1 success>=1', {}, draws(5, 0));
    expect(result.successes).toBe(1);
    expect(dice(result)[0]).toEqual({ value: 6, kept: false, success: false });
  });

  test('subtraction is left to right; a subtracted dice term is signed in natural', () => {
    const result = roll('1d20 - 1d4 - 2 + bonus', { bonus: 5 }, draws(9, 2));
    expect(result.natural).toBe(7);
    expect(result.modified).toBe(10);
  });

  test('zero never appears negative', () => {
    const result = roll('1dF - 1dF', {}, draws(1, 1));
    expect(Object.is(result.natural, 0)).toBe(true);
    expect(Object.is(result.modified, 0)).toBe(true);
    const subtracted = roll('1d6 - x', { x: -0 }, draws(0));
    expect(subtracted.terms[1]).toEqual({ kind: 'input', sign: -1, name: 'x', value: 0 });
    const zero = roll('1dF - 1d4 + 2', {}, draws(1, 1));
    expect(Object.is(zero.terms[1]?.kind === 'dice' && zero.terms[1].subtotal, -2)).toBe(true);
  });

  test.each([
    ['d4', 1, 4],
    ['d6', 1, 6],
    ['d8', 1, 8],
    ['d10', 1, 10],
    ['d12', 1, 12],
    ['d20', 1, 20],
    ['d100', 1, 100],
    ['dF', -1, 1],
  ] as const)('%s lands in %i to %i and reaches both ends', (die, low, high) => {
    const random = seededRandom(7);
    const seen = new Set<number>();
    for (let run = 0; run < 5_000; run += 1) {
      const [only] = dice(roll(`1${die}`, {}, random));
      if (only === undefined) throw new Error('no die');
      expect(only.value).toBeGreaterThanOrEqual(low);
      expect(only.value).toBeLessThanOrEqual(high);
      seen.add(only.value);
    }
    expect(seen.has(low)).toBe(true);
    expect(seen.has(high)).toBe(true);
    expect(seen.size).toBe(die === 'dF' ? 3 : Number(die.slice(1)));
  });

  test('every die type in the model is parseable', () => {
    for (const die of DIE_TYPES) expect(checkDiceSource(`1${die}`)).toBeUndefined();
  });

  test.each([
    ['', 'syntax'],
    ['d20', 'syntax'],
    ['dF', 'syntax'],
    ['1d7', 'unknown_die'],
    ['1d0', 'unknown_die'],
    ['1d1000', 'unknown_die'],
    ['1D20', 'syntax'],
    ['1df', 'syntax'],
    ['1d', 'syntax'],
    ['0d6', 'out_of_bounds'],
    ['4d6kh0', 'out_of_bounds'],
    ['4d6kh5', 'out_of_bounds'],
    ['4d6 kh3', 'syntax'],
    ['4d6kh3kl1', 'syntax'],
    ['4d6kx1', 'syntax'],
    ['4d6kh', 'syntax'],
    ['2d6*2', 'syntax'],
    ['2d6/2', 'syntax'],
    ['(1d6)', 'syntax'],
    ['-1+1d6', 'syntax'],
    ['+1d6', 'syntax'],
    ['1d6+', 'syntax'],
    ['1d6++1', 'syntax'],
    ['1d6 ', 'syntax'],
    [' 1d6', 'syntax'],
    ['1d6\t+1', 'syntax'],
    ['1d6\n', 'syntax'],
    ['01d6', 'syntax'],
    ['1d6+01', 'syntax'],
    ['1.5d6', 'syntax'],
    ['1d6+1.5', 'syntax'],
    ['1d6x', 'syntax'],
    ['3+2', 'no_dice'],
    ['skill', 'no_dice'],
    ['2d6+1 success>=6', 'invalid_success'],
    ['1d6+1d6 success>=6', 'invalid_success'],
    ['6d6success>=6', 'syntax'],
    ['6d6 success>=x', 'syntax'],
    ['6d6 success', 'syntax'],
    ['6d6 success>=', 'syntax'],
    ['6d6 success>=6 ', 'syntax'],
    ['6d6 success>=6+1', 'syntax'],
    ['6d6 success >= 6', 'syntax'],
    ['1000d6', 'out_of_bounds'],
    ['101d6', 'out_of_bounds'],
    ['60d6+60d6', 'out_of_bounds'],
    ['1d6+99999999', 'out_of_bounds'],
    ['99999999999999999999999d6', 'out_of_bounds'],
    ['1d6+d20', 'reserved_name'],
    ['1d6+dF', 'reserved_name'],
    ['1d6+success', 'reserved_name'],
    ['1d6+kh3', 'reserved_name'],
    ['1d6+constructor', 'reserved_name'],
    ['1d6+__proto__', 'reserved_name'],
    ['1d6+prototype', 'reserved_name'],
    ['1d6+eval(1)', 'syntax'],
    ['1d6;alert(1)', 'syntax'],
    ['1d6+a.b', 'syntax'],
    ['1d6+"x"', 'syntax'],
  ])('%p is refused with %s', (source, code) => {
    const parsed = parseRoll(source);
    expect(parsed.ok ? undefined : parsed.error.code).toBe(code as never);
  });

  test('spaces around operators are allowed; PRD examples all parse', () => {
    for (const source of [
      '1d20',
      '2d6+3',
      '4d6kh3',
      '1d20+ATTRIBUTE_A',
      '4dF',
      '6d6 success>=6',
      '4dF + skill',
      '1d6  -  2',
    ]) {
      expect(checkDiceSource(source)).toBeUndefined();
    }
  });

  test('the limit values themselves are accepted', () => {
    expect(checkDiceSource(`${ROLL_LIMITS.totalDice}d6`)).toBeUndefined();
    expect(checkDiceSource(`1d6+${ROLL_LIMITS.magnitude}`)).toBeUndefined();
    const terms = ['1d6', ...Array(ROLL_LIMITS.terms - 1).fill('1')].join('+');
    expect(checkDiceSource(terms)).toBeUndefined();
  });
});

describe('bounds', () => {
  test.each([
    ['past the length limit', `1d6${'+1'.repeat(ROLL_LIMITS.expressionLength)}`],
    ['past the term limit', ['1d6', ...Array(ROLL_LIMITS.terms).fill('1')].join('+')],
    ['megabytes of text', 'd'.repeat(5_000_000)],
    ['megabytes of digits', '9'.repeat(5_000_000)],
  ])('%s fails typed in bounded time', (_name, source) => {
    const started = performance.now();
    const parsed = parseRoll(source);
    expect(parsed.ok ? undefined : parsed.error.code).toBe('out_of_bounds');
    expect(performance.now() - started).toBeLessThan(200);
  });

  test('random text never throws', () => {
    const random = seededRandom(99);
    const alphabet = '0123456789dFkhlsuccess +-*/<>=()._"\\;\n';
    for (let run = 0; run < 5_000; run += 1) {
      let source = '';
      for (let index = random.nextInt(30); index > 0; index -= 1) {
        source += alphabet[random.nextInt(alphabet.length)];
      }
      const parsed = parseRoll(source);
      if (parsed.ok) evaluateRoll(parsed.value, { x: 1 }, random);
    }
  });

  test('a roll has no perceptible delay at the dice limit', () => {
    const parsed = parseRoll(`${ROLL_LIMITS.totalDice}d100kh50+3`);
    if (!parsed.ok) throw new Error('parse');
    const random = seededRandom(1);
    const started = performance.now();
    for (let run = 0; run < 1_000; run += 1) evaluateRoll(parsed.value, {}, random);
    expect((performance.now() - started) / 1_000).toBeLessThan(5);
  });
});

describe('inputs', () => {
  test('a missing name is typed and rolls nothing', () => {
    const parsed = parseRoll('1d20+ATTRIBUTE_A');
    if (!parsed.ok) throw new Error('parse');
    const result = evaluateRoll(parsed.value, {}, draws());
    expect(result).toEqual({
      ok: false,
      error: {
        code: 'missing_input',
        name: 'ATTRIBUTE_A',
        message: 'No value was supplied for ATTRIBUTE_A.',
      },
    });
  });

  test.each([
    ['a fraction', 1.5],
    ['text', '3'],
    ['infinity', Number.POSITIVE_INFINITY],
    ['NaN', Number.NaN],
    ['past the limit', ROLL_LIMITS.magnitude + 1],
    ['null', null],
    ['an object', {}],
  ])('%s is invalid_input and the value is not echoed', (_name, value) => {
    const parsed = parseRoll('1d6+x');
    if (!parsed.ok) throw new Error('parse');
    const result = evaluateRoll(parsed.value, { x: value }, draws());
    expect(result.ok ? undefined : result.error.code).toBe('invalid_input');
    if (!result.ok && typeof value === 'number') {
      expect(result.error.message).not.toContain(`${value}`);
    }
  });

  test('the prototype and accessors are not read', () => {
    const parsed = parseRoll('1d6+x');
    if (!parsed.ok) throw new Error('parse');
    const inherited = evaluateRoll(parsed.value, Object.create({ x: 1 }) as RollInputs, draws());
    expect(inherited.ok ? undefined : inherited.error.code).toBe('missing_input');
    let touched = false;
    const accessor = Object.defineProperty({}, 'x', {
      get() {
        touched = true;
        return 1;
      },
    }) as RollInputs;
    const refused = evaluateRoll(parsed.value, accessor, draws());
    expect(refused.ok ? undefined : refused.error.code).toBe('invalid_input');
    expect(touched).toBe(false);
  });

  test('a parse reports the names the caller must resolve', () => {
    const parsed = parseRoll('1d6+b+a-b');
    expect(parsed.ok && parsed.value.inputs).toEqual(['a', 'b']);
  });
});

describe('randomness', () => {
  test.each(ROLL_VECTORS.map((vector) => [vector.source, vector] as const))(
    'seeded vector: %s',
    (_source, vector) => {
      const result = roll(vector.source, vector.inputs, seededRandom(vector.seed));
      expect(dice(result).map((die) => die.value)).toEqual([...vector.faces]);
      expect(result.natural).toBe(vector.natural);
      expect(result.modified).toBe(vector.modified);
    },
  );

  test('the same seed gives the same roll; another seed differs', () => {
    expect(roll('20d20', {}, seededRandom(5))).toEqual(roll('20d20', {}, seededRandom(5)));
    expect(roll('20d20', {}, seededRandom(5))).not.toEqual(roll('20d20', {}, seededRandom(6)));
  });

  test('seeded dice are close to uniform', () => {
    const random = seededRandom(123);
    const counts = [0, 0, 0, 0, 0, 0];
    for (let run = 0; run < 60_000; run += 1) {
      const index = random.nextInt(6);
      counts[index] = (counts[index] ?? 0) + 1;
    }
    for (const count of counts) {
      expect(count).toBeGreaterThan(9_500);
      expect(count).toBeLessThan(10_500);
    }
  });

  test('production draws from the injected cryptographic generator and discards biased words', () => {
    // 2^32 % 3 is 1, so 4294967295 is the one word that would favour the lowest face.
    const words = [4294967295, 4294967295, 7];
    let calls = 0;
    const source = cryptoRandom({
      getRandomValues(values: Uint32Array) {
        values[0] = words[calls] as number;
        calls += 1;
        return values;
      },
    });
    expect(source.nextInt(3)).toBe(1);
    expect(calls).toBe(3);
  });

  test('production defaults to the platform generator and stays in range', () => {
    const random = cryptoRandom();
    for (let run = 0; run < 2_000; run += 1) {
      const [only] = dice(roll('1d20', {}, random));
      expect(only?.value).toBeGreaterThanOrEqual(1);
      expect(only?.value).toBeLessThanOrEqual(20);
    }
  });

  test('the engine reads no clock, global randomness, network, storage, formula, or host', () => {
    const directory = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
    const forbidden =
      /\b(eval|Function|globalThis|window|process|require|Date|Intl|fetch|setTimeout|setInterval|localStorage|Bun)\b|Math\.random|toLocale|import\(|@rpg\/formula|@rpg\/systems/;
    for (const name of readdirSync(directory)) {
      if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue;
      const code = readFileSync(join(directory, name), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      expect({ name, match: forbidden.exec(code)?.[0] }).toEqual({ name, match: undefined });
    }
  });
});

describe('replay', () => {
  const inputs = { skill: 2 };
  const faithful = roll('4d6kh3+skill', inputs, seededRandom(11));

  test('a faithful record reproduces itself, whatever its key order', () => {
    expect(replayRoll('4d6kh3+skill', inputs, faithful)).toBe(true);
    const reordered = JSON.parse(JSON.stringify(faithful)) as RollResult;
    expect(
      replayRoll('4d6kh3+skill', inputs, {
        modified: reordered.modified,
        natural: reordered.natural,
        terms: reordered.terms,
      }),
    ).toBe(true);
    const pool = roll('6d6 success>=5', {}, seededRandom(3));
    expect(replayRoll('6d6 success>=5', {}, pool)).toBe(true);
  });

  function tampered(change: (copy: Record<string, never> & RollResult) => void): RollResult {
    const copy = JSON.parse(JSON.stringify(faithful)) as Record<string, never> & RollResult;
    change(copy);
    return copy;
  }

  test.each<[string, (copy: RollResult & Record<string, unknown>) => void]>([
    ['the natural total', (copy) => Object.assign(copy, { natural: copy.natural + 1 })],
    ['the modified total', (copy) => Object.assign(copy, { modified: copy.modified + 1 })],
    ['a success count', (copy) => Object.assign(copy, { successes: 1 })],
    [
      'a face within range',
      (copy) => {
        const term = copy.terms[0] as unknown as { faces: { value: number }[] };
        const face = term.faces[0] as { value: number };
        face.value = face.value === 6 ? 5 : face.value + 1;
      },
    ],
    [
      'a face past the die',
      (copy) => {
        (
          (copy.terms[0] as unknown as { faces: { value: number }[] }).faces[0] as { value: number }
        ).value = 7;
      },
    ],
    [
      'a face below the die',
      (copy) => {
        (
          (copy.terms[0] as unknown as { faces: { value: number }[] }).faces[0] as { value: number }
        ).value = 0;
      },
    ],
    [
      'a fractional face',
      (copy) => {
        (
          (copy.terms[0] as unknown as { faces: { value: number }[] }).faces[0] as { value: number }
        ).value = 1.5;
      },
    ],
    [
      'a kept flag',
      (copy) => {
        const face = (copy.terms[0] as unknown as { faces: { kept: boolean }[] }).faces[0] as {
          kept: boolean;
        };
        face.kept = !face.kept;
      },
    ],
    [
      'an extra die',
      (copy) => {
        (copy.terms[0] as unknown as { faces: unknown[] }).faces.push({ value: 1, kept: false });
      },
    ],
    [
      'a missing die',
      (copy) => {
        (copy.terms[0] as unknown as { faces: unknown[] }).faces.pop();
      },
    ],
    ['a dropped term', (copy) => Object.assign(copy, { terms: copy.terms.slice(0, 1) })],
    ['terms that are not a list', (copy) => Object.assign(copy, { terms: 'x' })],
  ])('a changed %s is refused', (_name, change) => {
    expect(replayRoll('4d6kh3+skill', inputs, tampered(change as never))).toBe(false);
  });

  test('other inputs, another expression, or no result are refused', () => {
    expect(replayRoll('4d6kh3+skill', { skill: 3 }, faithful)).toBe(false);
    expect(replayRoll('4d6kh3+skill', {}, faithful)).toBe(false);
    expect(replayRoll('4d6kl3+skill', inputs, faithful)).toBe(false);
    expect(replayRoll('not dice', inputs, faithful)).toBe(false);
    expect(replayRoll('1d6', {}, null as never)).toBe(false);
  });
});
