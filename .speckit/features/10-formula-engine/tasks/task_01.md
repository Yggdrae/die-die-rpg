# Task 01: Parser and AST

Status: completed (2026-10-31)

## Scope

- `packages/formula`: package, `ast.ts`, `failures.ts`, `limits.ts`, `parser.ts`.
- Grammar in `_techspec.md`; source, depth, and literal limits enforced during parsing.

## Acceptance Criteria

- Every syntax row of BDD "A formula outside the language" fails with `syntax` and a position.
- Depth and length limits fail typed; a 100 000-parenthesis input is refused without a stack overflow.

## Verification

```bash
bun test packages/formula
```
