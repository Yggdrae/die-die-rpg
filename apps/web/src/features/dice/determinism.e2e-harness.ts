import { evaluateRoll, parseRoll, ROLL_VECTORS, seededRandom } from '@rpg/dice/engine';
import { compileFormula, evaluateFormula, FORMULA_VECTORS } from '@rpg/formula';

/**
 * Playwright-only (imported dynamically from `determinism.e2e.ts`). Runs the published vector tables in
 * the browser's JavaScript engine and returns what disagrees. Bun runs the same tables in the packages'
 * tests, so both engines answer to the table rather than to each other.
 */

export function formulaFailures(): { readonly count: number; readonly wrong: readonly unknown[] } {
  const wrong: unknown[] = [];
  for (const vector of FORMULA_VECTORS) {
    const compiled = compileFormula(vector.source);
    const result = compiled.ok ? evaluateFormula(compiled.value, vector.context) : compiled;
    if (!result.ok || !Object.is(result.value, vector.result)) wrong.push({ vector, result });
  }
  return { count: FORMULA_VECTORS.length, wrong };
}

export function rollFailures(): { readonly count: number; readonly wrong: readonly unknown[] } {
  const wrong: unknown[] = [];
  for (const vector of ROLL_VECTORS) {
    const parsed = parseRoll(vector.source);
    const result = parsed.ok
      ? evaluateRoll(parsed.value, vector.inputs, seededRandom(vector.seed))
      : parsed;
    const faces = result.ok
      ? result.value.terms.flatMap((term) =>
          term.kind === 'dice' ? term.faces.map((face) => face.value) : [],
        )
      : [];
    if (
      !result.ok ||
      JSON.stringify(faces) !== JSON.stringify(vector.faces) ||
      result.value.natural !== vector.natural ||
      result.value.modified !== vector.modified
    ) {
      wrong.push({ vector, result });
    }
  }
  return { count: ROLL_VECTORS.length, wrong };
}
