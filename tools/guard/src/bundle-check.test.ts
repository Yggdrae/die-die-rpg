import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ALLOWED_BY_BUILD, disallowed, occurrencesIn, scanDirectory } from './bundle-check.ts';

const ROOT = new URL('../../../', import.meta.url);

describe('bundle check (feature 10 D-12)', () => {
  test.each([
    'eval(code)',
    'new Function("return 1")',
    'x=new  Function(a,b)',
    'globalThis.Function(a)',
    'window.eval(a)',
    'Function("return this")()',
    ';eval (x)',
  ])('FAILS on %s', (text) => {
    expect(occurrencesIn('bundle.js', text).length).toBe(1);
  });

  test.each([
    'evaluate(code)',
    'retrieval(code)',
    'myFunction(x)',
    'x.eval(y)',
    'foo.Function(y)',
    'typeof x === "function"',
    '$eval(x)',
    'class Function2 {}',
    'Function([Any()], Any())',
    'Function(parameters, returns, options)',
  ])('PASSES for %s', (text) => {
    expect(occurrencesIn('bundle.js', text)).toEqual([]);
  });

  test('a scan finds a planted use, and the browser allows only the named shim', () => {
    const directory = mkdtempSync(join(tmpdir(), 'bundle-check-'));
    try {
      writeFileSync(join(directory, 'clean.js'), 'const a = 1;');
      writeFileSync(join(directory, 'planted.js'), 'const a = new Function("x");');
      writeFileSync(join(directory, 'notes.txt'), 'eval(text) is not JavaScript here');
      const found = scanDirectory(directory);
      expect(found.map((item) => item.file.endsWith('planted.js'))).toEqual([true]);
      expect(disallowed(found, ALLOWED_BY_BUILD.web ?? []).length).toBe(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('the server allow list names exact sites, so a new one is refused', () => {
    const allowed = ALLOWED_BY_BUILD.api ?? [];
    expect(
      disallowed(occurrencesIn('main.js', 'const makeParse = new Function(a)'), allowed),
    ).toEqual([]);
    expect(
      disallowed(occurrencesIn('main.js', 'const formula = new Function(a)'), allowed).length,
    ).toBe(1);
  });

  test.each([
    ['@rpg/formula', 'packages/formula/src/index.ts'],
    ['@rpg/dice engine', 'packages/dice/src/engine/index.ts'],
  ])('%s bundled alone has no eval and no Function', (_name, entry) => {
    // A separate process: in-process builds read package files intermittently on Windows once a large
    // suite has loaded the same modules.
    const built = Bun.spawnSync(
      [
        'bun',
        'build',
        new URL(entry, ROOT).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
        '--target=browser',
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    expect(built.exitCode).toBe(0);
    const text = built.stdout.toString();
    expect(text.length).toBeGreaterThan(1_000);
    expect(occurrencesIn(entry, text)).toEqual([]);
  });
});
