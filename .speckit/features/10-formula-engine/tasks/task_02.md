# Task 02: Validator and interpreter

Status: completed (2026-10-31)

## Scope

- `validator.ts`: allow list, arity, literal types, forbidden identifiers, operation and depth limits, dependency extraction.
- `interpreter.ts`: safe-integer arithmetic (D-02, D-03), own-data-property context reads, untrusted AST checks.

## Acceptance Criteria

- BDD "A formula computes its value" and "Failures Are Typed" pass row by row.
- No failure message contains a context value.
- A hand-built AST with an unknown node, unknown function, or cycle fails typed.

## Verification

```bash
bun test packages/formula
```
