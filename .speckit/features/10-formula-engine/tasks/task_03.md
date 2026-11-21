# Task 03: Dependencies, cycles, adversarial corpus, determinism

Status: completed (2026-10-31)

## Scope

- `dependencies.ts`: `findFormulaCycles`, `checkFormulaSource`, `checkFormulaCycles`.
- Adversarial corpus, seeded fuzz, determinism vectors, source scan.

## Acceptance Criteria

- BDD "Containment", "Determinism", and "Dependencies" pass.
- `Object.prototype` and `globalThis` are unchanged after the corpus.

## Verification

```bash
bun test packages/formula
```
