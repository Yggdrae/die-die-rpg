import { compileFormula } from './validator.ts';

/**
 * Dependency cycles (FR-010, D-10) and the two `ExpressionValidators` entries feature 08 calls at
 * package load. Plain functions of text, so the composition passes them as they are and
 * `@rpg/systems` never imports this package.
 */

export interface FormulaNode {
  readonly key: string;
  readonly source: string;
}

/**
 * Each cycle among named formulas, as the keys around it, once. A node that does not compile is
 * skipped: it is already reported on its own. An identifier naming no node is an input, not an edge.
 */
export function findFormulaCycles(nodes: readonly FormulaNode[]): readonly (readonly string[])[] {
  const edges = new Map<string, readonly string[]>();
  for (const { key, source } of nodes) {
    const compiled = compileFormula(source);
    edges.set(key, compiled.ok ? compiled.value.dependencies : []);
  }
  const cycles: string[][] = [];
  const seen = new Set<string>();
  const finished = new Set<string>();
  // An explicit stack: a package is untrusted, so its chain length must not reach the call stack.
  for (const root of [...edges.keys()].sort()) {
    if (seen.has(root)) continue;
    seen.add(root);
    const path = [root];
    const stack = [{ key: root, next: 0 }];
    for (let top = stack.at(-1); top !== undefined; top = stack.at(-1)) {
      const targets = edges.get(top.key) ?? [];
      if (top.next >= targets.length) {
        finished.add(top.key);
        stack.pop();
        path.pop();
        continue;
      }
      const target = targets[top.next] as string;
      top.next += 1;
      if (!edges.has(target) || finished.has(target)) continue;
      if (seen.has(target)) {
        cycles.push(path.slice(path.indexOf(target)));
        continue;
      }
      seen.add(target);
      path.push(target);
      stack.push({ key: target, next: 0 });
    }
  }
  return cycles;
}

/** `ExpressionValidators.formula`: an error message, or `undefined` when the source is valid. */
export function checkFormulaSource(source: string): string | undefined {
  const compiled = compileFormula(source);
  return compiled.ok ? undefined : `${compiled.error.code}: ${compiled.error.message}`;
}

/** `ExpressionValidators.formulaCycles`: one entry per cycle, anchored at its first key. */
export function checkFormulaCycles(
  nodes: readonly FormulaNode[],
): readonly { readonly key: string; readonly message: string }[] {
  return findFormulaCycles(nodes).map((cycle) => ({
    key: cycle[0] as string,
    message: `These formulas read each other: ${cycle.join(', ')}.`,
  }));
}
