import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FORMULA_VECTORS } from './determinism-vectors.ts';
import {
  checkFormulaCycles,
  checkFormulaSource,
  compileFormula,
  evaluateFormula,
  FORMULA_LIMITS,
  type FormulaAst,
  type FormulaContext,
  type FormulaFailureCode,
  findFormulaCycles,
  formulaDependencies,
  parseFormula,
  validateFormula,
} from './index.ts';

function evaluate(source: string, context: FormulaContext = {}) {
  const compiled = compileFormula(source);
  if (!compiled.ok) throw new Error(`does not compile: ${source}: ${compiled.error.message}`);
  return evaluateFormula(compiled.value, context);
}

function compileCode(source: string): string | undefined {
  const compiled = compileFormula(source);
  return compiled.ok ? undefined : compiled.error.code;
}

describe('language', () => {
  const context = { ATTRIBUTE_A: 12, RESOURCE_A: 0, level: 3, armor: 5, flag: true };
  test.each([
    ['10 + ATTRIBUTE_A', 22],
    ['level * 2', 6],
    ['min(armor, 3)', 3],
    ['ATTRIBUTE_A > 10', true],
    ['RESOURCE_A <= 0', true],
    ['-(level - 5) * 2', 4],
    ['7 / 2', 3],
    ['-7 / 2', -4],
    ['flag == true', true],
    ['level != 3', false],
  ] as const)('%s = %p', (source, result) => {
    expect(evaluate(source, context)).toEqual({ ok: true, value: result });
  });

  test.each([
    ['', 'syntax'],
    ['1 +', 'syntax'],
    ['1.5 + 2', 'syntax'],
    ['0x10', 'syntax'],
    ['1e3', 'syntax'],
    ['"text" == name', 'syntax'],
    ["'text' == name", 'syntax'],
    ['a = 1', 'syntax'],
    ['a < b < c', 'syntax'],
    ['a < b == c', 'syntax'],
    ['actor.level', 'syntax'],
    ['a[0]', 'syntax'],
    ['a; b', 'syntax'],
    ['a b', 'syntax'],
    ['(1', 'syntax'],
    ['min(1, 2', 'syntax'],
    ['min(1,, 2)', 'syntax'],
    ['1 ? 2 : 3', 'syntax'],
    ['a && b', 'syntax'],
    ['!a', 'syntax'],
    ['max(1, 2)', 'unknown_function'],
    ['eval(1)', 'unknown_function'],
    ['Function(1)', 'unknown_function'],
    ['import(1)', 'unknown_function'],
    ['require(1)', 'unknown_function'],
    ['constructor(1)', 'unknown_function'],
    ['__proto__(1)', 'unknown_function'],
    ['min()', 'arity'],
    ['min(1)', 'arity'],
    ['min(1,2,3,4,5,6,7,8,9)', 'arity'],
    ['1 + true', 'type_mismatch'],
    ['min(true, 1)', 'type_mismatch'],
    ['(1 < 2) + 1', 'type_mismatch'],
    ['-true', 'type_mismatch'],
    ['true < 1', 'type_mismatch'],
    ['true == 1', 'type_mismatch'],
    ['x / 0', 'division_by_zero'],
    ['x / -0', 'division_by_zero'],
    ['constructor', 'forbidden_identifier'],
    ['__proto__', 'forbidden_identifier'],
    ['prototype + 1', 'forbidden_identifier'],
  ] as const)('%p is refused with %s', (source, code) => {
    expect(compileCode(source)).toBe(code);
  });

  test('a syntax failure carries its position', () => {
    const parsed = parseFormula('1 + @');
    expect(parsed).toEqual({
      ok: false,
      error: { code: 'syntax', message: 'Unexpected character.', position: 4 },
    });
  });

  test('negative zero never appears', () => {
    for (const source of ['0 * -1', '-(0)', '0 / -5', 'min(-0, 0)']) {
      const result = evaluate(source);
      expect(result.ok && Object.is(result.value, 0)).toBe(true);
    }
    const fromContext = evaluate('x', { x: -0 });
    expect(fromContext.ok && Object.is(fromContext.value, 0)).toBe(true);
  });

  test('stages are separately usable', () => {
    const ast = parseFormula('a + 1');
    if (!ast.ok) throw new Error('parse');
    expect(ast.value).toEqual({
      kind: 'arithmetic',
      operator: '+',
      left: { kind: 'identifier', name: 'a' },
      right: { kind: 'number', value: 1 },
    });
    const valid = validateFormula(ast.value);
    if (!valid.ok) throw new Error('validate');
    expect(valid.value.resultType).toBe('number');
    expect(evaluateFormula(ast.value, { a: 1 })).toEqual({ ok: true, value: 2 });
    expect(evaluateFormula(valid.value, { a: 2 })).toEqual({ ok: true, value: 3 });
  });

  test('result types are inferred where literals allow', () => {
    const types = ['1 + a', 'a < 1', 'a', 'true'].map((source) => {
      const compiled = compileFormula(source);
      return compiled.ok ? compiled.value.resultType : undefined;
    });
    expect(types).toEqual(['number', 'boolean', 'unknown', 'boolean']);
  });
});

describe('typed failures at evaluation', () => {
  const SECRET = 424242;
  test.each([
    ['missing + 1', {}, 'unknown_identifier'],
    ['x + 1', { x: 'text' }, 'invalid_context_value'],
    ['x + 1', { x: 1.5 }, 'invalid_context_value'],
    ['x + 1', { x: Number.POSITIVE_INFINITY }, 'invalid_context_value'],
    ['x + 1', { x: Number.NaN }, 'invalid_context_value'],
    ['x + 1', { x: 2 ** 60 }, 'invalid_context_value'],
    ['x + 1', { x: {} }, 'invalid_context_value'],
    ['x + 1', { x: null }, 'invalid_context_value'],
    ['x + 1', { x: true }, 'type_mismatch'],
    ['x == 1', { x: true }, 'type_mismatch'],
    ['x < 1', { x: true }, 'type_mismatch'],
    ['min(x, 1)', { x: true }, 'type_mismatch'],
    ['1 / x', { x: 0 }, 'division_by_zero'],
    ['x * x', { x: 2 ** 40 }, 'limit_exceeded'],
    ['x + x', { x: Number.MAX_SAFE_INTEGER }, 'limit_exceeded'],
  ] as const)('%s with %p is %s', (source, context, code) => {
    const result = evaluate(source, context as FormulaContext);
    expect(result.ok ? undefined : result.error.code).toBe(code);
  });

  test('no failure message carries a context value', () => {
    const cases: readonly [string, FormulaContext][] = [
      ['missing + secret', { secret: SECRET }],
      ['secret + 1', { secret: `${SECRET}` }],
      ['secret + 1', { secret: SECRET + 0.5 }],
      ['flag + secret', { flag: true, secret: SECRET }],
      ['secret / zero', { secret: SECRET, zero: 0 }],
      ['secret * secret * secret * secret', { secret: SECRET }],
    ];
    for (const [source, context] of cases) {
      const result = evaluate(source, context);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(JSON.stringify(result.error)).not.toContain(`${SECRET}`);
    }
  });
});

describe('containment', () => {
  function bounded(run: () => unknown): void {
    const started = performance.now();
    run();
    expect(performance.now() - started).toBeLessThan(1_000);
  }

  test.each([
    ['a source past the length limit', 'x'.repeat(FORMULA_LIMITS.sourceLength + 1)],
    ['parentheses past the depth limit', `${'('.repeat(200)}1${')'.repeat(200)}`],
    ['one hundred thousand parentheses', '('.repeat(100_000)],
    ['unary minus past the depth limit', `${'-'.repeat(200)}1`],
    ['a sum past the operation limit', Array(200).fill('1').join('+')],
    ['nested calls', `${'min(1,'.repeat(60)}1${')'.repeat(60)}`],
    ['a huge literal', '9'.repeat(40)],
    ['a long name', 'n'.repeat(FORMULA_LIMITS.identifierLength + 1)],
  ])('%s fails typed', (_name, source) => {
    bounded(() => {
      const code = compileCode(source);
      expect(code).toBeOneOf(['limit_exceeded', 'syntax']);
    });
  });

  test('host names are ordinary missing identifiers and never resolve', () => {
    for (const name of [
      'globalThis',
      'window',
      'self',
      'process',
      'eval',
      'Function',
      'require',
      'module',
      'Object',
      'Bun',
      'fetch',
      'setTimeout',
    ]) {
      const result = evaluate(name, {});
      expect(result.ok ? undefined : result.error.code).toBe('unknown_identifier');
    }
  });

  test('JavaScript in the source is refused and does not run', () => {
    const marker = globalThis as { __formulaEscape?: boolean };
    for (const source of [
      'globalThis.__formulaEscape = true',
      '(function(){ globalThis.__formulaEscape = true })()',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal text is the hostile input.
      '`${1}`',
      'new Function("return 1")()',
      'import("x")',
      'a.constructor.constructor("return this")()',
      "constructor['constructor']",
      '1; process.exit(1)',
      '/* */ 1',
      '// 1',
    ]) {
      const parsed = compileFormula(source);
      expect(parsed.ok).toBe(false);
    }
    expect(marker.__formulaEscape).toBeUndefined();
  });

  test('a context cannot be reached through its prototype or an accessor', () => {
    let read = false;
    const accessor = Object.defineProperty({}, 'x', {
      enumerable: true,
      get() {
        read = true;
        return 1;
      },
    }) as FormulaContext;
    const fromAccessor = evaluate('x', accessor);
    expect(fromAccessor.ok ? undefined : fromAccessor.error.code).toBe('invalid_context_value');
    expect(read).toBe(false);
    const inherited = Object.create({ x: 1 }) as FormulaContext;
    const fromPrototype = evaluate('x', inherited);
    expect(fromPrototype.ok ? undefined : fromPrototype.error.code).toBe('unknown_identifier');
    const inheritedMethod = evaluate('toString', {});
    expect(inheritedMethod.ok ? undefined : inheritedMethod.error.code).toBe('unknown_identifier');
    const hasOwn = evaluate('hasOwnProperty', {});
    expect(hasOwn.ok ? undefined : hasOwn.error.code).toBe('unknown_identifier');
  });

  test('the interpreter does not trust a hand-built tree', () => {
    const hostile: readonly [unknown, FormulaFailureCode][] = [
      [{ kind: 'statement' }, 'syntax'],
      [null, 'syntax'],
      [{ kind: 'identifier', name: '__proto__' }, 'forbidden_identifier'],
      [{ kind: 'call', name: 'constructor', args: [] }, 'unknown_function'],
      [{ kind: 'call', name: 'hasOwnProperty', args: [] }, 'unknown_function'],
      [{ kind: 'call', name: 'min', args: 'xx' }, 'arity'],
      [{ kind: 'number', value: 1.5 }, 'type_mismatch'],
      [{ kind: 'number', value: '1' }, 'type_mismatch'],
      [{ kind: 'boolean', value: 1 }, 'type_mismatch'],
      [
        {
          kind: 'arithmetic',
          operator: '**',
          left: { kind: 'number', value: 1 },
          right: { kind: 'number', value: 1 },
        },
        'syntax',
      ],
      [{ kind: 'negate' }, 'syntax'],
    ];
    for (const [tree, code] of hostile) {
      const result = evaluateFormula(tree as FormulaAst, {});
      expect(result.ok ? undefined : result.error.code).toBe(code);
    }
  });

  test('a cyclic or oversized hand-built tree terminates typed', () => {
    const cycle: { kind: 'negate'; operand: unknown } = { kind: 'negate', operand: undefined };
    cycle.operand = cycle;
    bounded(() => {
      const result = evaluateFormula(cycle as FormulaAst, {});
      expect(result.ok ? undefined : result.error.code).toBe('limit_exceeded');
      const validated = validateFormula(cycle as FormulaAst);
      expect(validated.ok ? undefined : validated.error.code).toBe('limit_exceeded');
    });
    const wide = {
      kind: 'call',
      name: 'min',
      args: Array.from({ length: 1000 }, () => ({ kind: 'number', value: 1 })),
    };
    const result = evaluateFormula(wide as FormulaAst, {});
    expect(result.ok ? undefined : result.error.code).toBe('arity');
  });

  test('the corpus leaves the environment unchanged', () => {
    const before = Object.getOwnPropertyNames(Object.prototype).sort();
    const globals = Object.getOwnPropertyNames(globalThis).sort();
    for (const source of ['__proto__ + 1', 'constructor', 'prototype', 'a + b']) {
      const compiled = compileFormula(source);
      if (compiled.ok) evaluateFormula(compiled.value, { a: 1, b: 2 });
    }
    expect(Object.getOwnPropertyNames(Object.prototype).sort()).toEqual(before);
    expect(Object.getOwnPropertyNames(globalThis).sort()).toEqual(globals);
  });

  test('random text through the whole pipeline never throws', () => {
    // A small deterministic generator: the corpus is the same on every run.
    let state = 0x9e3779b9;
    const next = () => {
      state = Math.imul(state ^ (state >>> 15), 1 | state);
      state ^= state + Math.imul(state ^ (state >>> 7), 61 | state);
      return (state ^ (state >>> 14)) >>> 0;
    };
    const alphabet = 'abxyz019 ()+-*/<>=!,._"\'`$\\;[]{}\n\t@#%^&|~?:';
    for (let run = 0; run < 5_000; run += 1) {
      let source = '';
      const length = next() % 40;
      for (let index = 0; index < length; index += 1) {
        source += alphabet[next() % alphabet.length];
      }
      const compiled = compileFormula(source);
      if (compiled.ok) evaluateFormula(compiled.value, { a: 1, b: 2, x: 3, y: true, z: 0 });
    }
  });

  test('a valid formula evaluates faster than a frame, repeatedly', () => {
    const compiled = compileFormula('min(a + b * 2, 3) - (c / 2) + 1 <= 5 + a');
    if (!compiled.ok) throw new Error('compile');
    const started = performance.now();
    for (let run = 0; run < 10_000; run += 1) {
      evaluateFormula(compiled.value, { a: run, b: 2, c: 3 });
    }
    // Far under one 16 ms frame per evaluation, with margin for a loaded machine.
    expect((performance.now() - started) / 10_000).toBeLessThan(1);
  });
});

describe('determinism', () => {
  test.each(FORMULA_VECTORS.map((vector) => [vector.source, vector] as const))(
    '%s',
    (_source, vector) => {
      const first = evaluate(vector.source, vector.context);
      expect(first).toEqual({ ok: true, value: vector.result });
      expect(evaluate(vector.source, vector.context)).toEqual(first);
    },
  );

  test('no time, randomness, locale, environment, or host access in the engine source', () => {
    const directory = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
    const forbidden =
      /\b(eval|Function|globalThis|window|process|require|Date|Intl|fetch|setTimeout|setInterval|localStorage|Bun)\b|Math\.random|toLocale|import\(/;
    for (const name of readdirSync(directory)) {
      if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue;
      const code = readFileSync(join(directory, name), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      expect({ name, match: forbidden.exec(code)?.[0] }).toEqual({ name, match: undefined });
    }
  });
});

describe('dependencies and cycles', () => {
  test('a formula reports what it reads, sorted and unique', () => {
    const compiled = compileFormula('min(armor, 3) + level + armor');
    if (!compiled.ok) throw new Error('compile');
    expect(formulaDependencies(compiled.value)).toEqual(['armor', 'level']);
    const none = compileFormula('1 + 2');
    expect(none.ok && none.value.dependencies).toEqual([]);
  });

  test('a cycle is found once and named', () => {
    const cycles = findFormulaCycles([
      { key: 'a', source: 'b + 1' },
      { key: 'b', source: 'c + 1' },
      { key: 'c', source: 'a + 1' },
      { key: 'free', source: 'input * 2' },
    ]);
    expect(cycles).toEqual([['a', 'b', 'c']]);
  });

  test('a self-reference is a cycle', () => {
    expect(findFormulaCycles([{ key: 'a', source: 'a + 1' }])).toEqual([['a']]);
  });

  test('a shared dependency and a chain are not cycles', () => {
    expect(
      findFormulaCycles([
        { key: 'top', source: 'left + right' },
        { key: 'left', source: 'base + 1' },
        { key: 'right', source: 'base + 2' },
        { key: 'base', source: 'input' },
      ]),
    ).toEqual([]);
  });

  test('a node that does not compile is not an edge', () => {
    expect(
      findFormulaCycles([
        { key: 'a', source: 'b +' },
        { key: 'b', source: 'a' },
      ]),
    ).toEqual([]);
  });

  test('a long chain does not exhaust the check', () => {
    const nodes = Array.from({ length: 50_000 }, (_, index) => ({
      key: `n${index}`,
      source: `n${index + 1}`,
    }));
    expect(findFormulaCycles(nodes)).toEqual([]);
  });

  test('the load entries answer in the port shape', () => {
    expect(checkFormulaSource('1 + 1')).toBeUndefined();
    expect(checkFormulaSource('1 +')).toStartWith('syntax:');
    expect(checkFormulaCycles([{ key: 'a', source: 'a' }])).toEqual([
      { key: 'a', message: 'These formulas read each other: a.' },
    ]);
    expect(checkFormulaCycles([{ key: 'a', source: 'b' }])).toEqual([]);
  });
});
