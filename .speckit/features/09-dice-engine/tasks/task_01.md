# Task 01: Parser and evaluator

Status: completed (2026-10-31)

## Scope

- `packages/dice/src/engine`: grammar, limits, parser, evaluator, randomness sources, replay, `checkDiceSource`.

## Acceptance Criteria

- BDD "Notation" and "Determinism and Randomness" pass row by row.
- Same seed, same result; rejection sampling proven with a stub generator.
- Replay refuses every tampered field.

## Verification

```bash
bun test packages/dice/src/engine
```
