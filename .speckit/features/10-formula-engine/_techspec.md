# TechSpec: Formula Engine

Source: `_prd.md`, `_bdd.md`, `PRD.md` s.24, s.75, s.91. P0 only.

## Current Facts

- `packages/systems/src/load.ts` has the `ExpressionValidators` port: `formula?: (source) => string |
  undefined`, called for every `{ formula }` at any depth. Nothing plugs into it yet.
- Formulas declared today: `level + 3`, `roll <= attribute`, `roll - armor <= guard`, `armor - roll`,
  `margin > 0` (`packages/systems/src/paradigms.test-support.ts`), `VIGOR + 2` (`@rpg/fixtures`).
- `SystemPackage` caps a formula at 500 characters (`FormulaExpression`).
- `Result`, `ok`, `err` are in `@rpg/contracts`.
- The web application chunks have no `new Function` or `eval(`. The vendored PowerSync SQLite worker
  (`dist/sync-assets/`, shipped) has one webpack shim, `new Function('return this')`, on a constant string.
  The API bundle has nine `new Function`, all from Fastify, Ajv, and `find-my-way` route and schema
  compilation on trusted input.

## Decisions (open PRD questions closed; delegated by the owner, 2026-10-31)

- **D-01 Pure package `@rpg/formula`.** Depends on `@rpg/contracts` only, for `Result`. A guard rule
  keeps it so, and refuses runtime and host names in its source.
- **D-02 Numbers are safe integers. No floating point exists in the language.** Literals and context
  numbers must be `Number.isSafeInteger`. Every intermediate result is checked, and leaving the
  range is `limit_exceeded`. This makes results identical on every engine, since IEEE rounding,
  float formatting, and locale cannot enter. Negative zero is normalized to zero.
- **D-03 Division floors.** `/` is integer division rounded toward negative infinity, computed as
  `(a - mod(a, b)) / b`, which is exact where `Math.floor(a / b)` is not near 2^53. This is the only
  rounding rule. `/` exists because FR-009 names division by zero as an expected failure.
- **D-04 No strings in MVP.** Neither Cairn nor Fate has a declared formula comparing text, and
  FR-003's "string comparison" was conditional on need (open question closed as "not needed"). A
  string literal is a syntax error; a text context value is `invalid_context_value`. Adding text is a
  reviewed widening with a named system.
- **D-05 Function set: `min` only, with 2 to 8 arguments.** `max`, `floor`, `ceil`, `round`, `clamp`,
  `abs` stay P1 (FR-101). `min(armor - roll, 0)` covers the damage shape that looks like it needs
  `max`, and `floor`/`round` are meaningless on integers.
- **D-06 Operators.** Arithmetic `+ - * /`, unary `-`, comparison `< <= > >= == !=`, parentheses. No
  logical operators: no declared formula needs them, and outcome branches are ordered by feature 11.
  `<` family applies to numbers. `==`/`!=` compare two values of one type. Comparison does not chain:
  `a < b < c` and `a < b == c` are syntax errors, and parentheses make the intent explicit.
- **D-07 Identifiers are flat names.** `[A-Za-z_][A-Za-z0-9_]*`, at most 64 characters, resolved by
  exact, case-sensitive match on an own data property of the context. No member access. `PRD.md` s.22's
  `actor.ATTRIBUTE_A` is written `ATTRIBUTE_A`, bound by feature 11, because a dot reads as property
  access, which is what this boundary refuses. `__proto__`, `constructor`, `prototype` are refused
  at compile. `true` and `false` are reserved.
- **D-08 Limits.**

  | Limit | Value | Enforced |
  | --- | --- | --- |
  | Source length | 500 characters (matches the package schema) | parser |
  | AST depth | 32 | parser, validator, interpreter |
  | Operations (AST nodes) | 256 | parser, validator, interpreter |
  | Function arguments | 8 | validator, interpreter |
  | Literal magnitude | `Number.MAX_SAFE_INTEGER` | parser |
  | Value magnitude | `Number.MAX_SAFE_INTEGER` | interpreter |

  The parser enforces depth during descent, so hostile nesting cannot overflow the stack.
- **D-09 Identifiers are not checked against the package at load.** `roll`, `margin`, `attribute`, and
  `level` in the paradigm packages are not declared fields: feature 11 and feature 15 bind them
  (FR-004). Load proves syntax, functions, arity, and literal types. A name missing at run time is a
  typed `unknown_identifier`. Feature 11 owns naming what it binds.
- **D-10 Cycle check is a separate port entry.** `ExpressionValidators` gains optional
  `formulaCycles(nodes)`. `@rpg/systems` collects nodes (computed fields, resource `max`, inventory
  `capacity`, each keyed by its declaration key), the engine owns the graph, and `load.ts` adds a
  `formula_cycle` code. Conservative by design: a resource's key stands for both its value and its
  maximum, so a formula reading a resource and read by that resource's `max` is refused.
- **D-11 Composition, not dependency.** `@rpg/systems` stays pure and imports no engine. The API
  composition (`apps/api/src/modules/systems/registry.ts`) builds the registry with the engines'
  validators and loads the installed packages through it. `runConformance(candidate, validators?)`
  takes the same object, so features 12 and 13 run the kit with the real engines.
- **D-12 Bundle check at build.** `tools/guard/src/bundle-check.ts` scans emitted JavaScript for
  `eval(`, `new Function(`, and `Function('literal`, and runs as the last step of the web and API `build`
  scripts. Web allows only the one webpack shim named above. The API allows only the nine exact Fastify,
  Ajv, and `find-my-way` sites. All of them compile constants or trusted schemas, and package content never
  reaches them. Any new occurrence fails the build. Recorded plainly: the PRD's "zero" holds for
  `@rpg/formula` and the dice engine bundled alone, asserted by test, and for the code we write. It does
  not hold literally for third-party code in the shipped bundles, which the check pins instead of hiding.

## Pipeline

```text
source -> parseFormula -> FormulaAst -> validateFormula -> CompiledFormula -> evaluateFormula -> value
```

Grammar:

```text
formula        := comparison
comparison     := additive [ compare-op additive ]
additive       := multiplicative { ('+' | '-') multiplicative }
multiplicative := unary { ('*' | '/') unary }
unary          := '-' unary | primary
primary        := integer | 'true' | 'false' | identifier | call | '(' comparison ')'
call           := identifier '(' [ comparison { ',' comparison } ] ')'
```

Whitespace is space, tab, and newline. Evaluation order is left to right, depth first, with no short
circuit, so the operation count is a function of the formula alone.

## Module API

```ts
export type FormulaValue = number | boolean;
export type FormulaSource = string;
export type FormulaContext = Readonly<Record<string, unknown>>;

export type FormulaFailureCode =
  | 'syntax' | 'unknown_function' | 'arity' | 'type_mismatch' | 'forbidden_identifier'
  | 'unknown_identifier' | 'invalid_context_value' | 'division_by_zero' | 'limit_exceeded';

export interface FormulaFailure {
  readonly code: FormulaFailureCode;
  readonly message: string;   // never a context value
  readonly position?: number; // source offset, from the parser
}

export function parseFormula(source: FormulaSource): Result<FormulaAst, FormulaFailure>;
export function validateFormula(ast: FormulaAst): Result<CompiledFormula, FormulaFailure>;
export function compileFormula(source: FormulaSource): Result<CompiledFormula, FormulaFailure>;
export function evaluateFormula(
  formula: CompiledFormula | FormulaAst,
  context: FormulaContext,
): Result<FormulaValue, FormulaFailure>;
export function formulaDependencies(formula: CompiledFormula): readonly string[];
export function findFormulaCycles(
  nodes: readonly { key: string; source: FormulaSource }[],
): readonly (readonly string[])[];

// ExpressionValidators entries, usable as they are:
export function checkFormulaSource(source: string): string | undefined;
export function checkFormulaCycles(
  nodes: readonly { key: string; source: string }[],
): readonly { key: string; message: string }[];
```

`CompiledFormula` is `{ ast, dependencies, resultType }`, with `resultType` being `number`, `boolean`,
or `unknown` (a bare identifier). `validateFormula` infers literal types: an identifier is compatible
with anything until run time. A literal zero divisor is refused statically.

The interpreter does not trust its input. It re-checks node kinds, the function allow list (a frozen
`Map`, never a property lookup), depth, operation count, and types, because a caller can pass any AST.
Context values are read with `Object.getOwnPropertyDescriptor`, so no accessor runs and no prototype
is consulted.

## Failure Handling

Everything in FR-009 is a `Result`. No exception is thrown for any input. Messages name the formula's
own identifiers and limits, and never a context value, because a context may hold GM-only data.

## Authorization, Offline, Sync, Persistence

None. The engine holds nothing and has no I/O, so it works offline by construction. The caller decides
what a context contains and must not place a GM-only value in a player's context.

## Security

The interpreter is the boundary (`PRD.md` s.75). There is no `eval`, `Function`, dynamic import, global
read, or property access by a formula-controlled name. Language growth is a reviewed widening
(`adrs/ADR-001-ast-interpreter.md`).

## Test Strategy

- Unit per stage: parser (grammar, positions, limits), validator (types, arity, allow list), interpreter
  (values, failures, untrusted ASTs).
- Adversarial corpus: BDD "Hostile input", each asserted to fail typed under a time bound, with
  `Object.prototype` and `globalThis` unchanged.
- Determinism: a vector table run in Bun (`formula.test.ts`) and in the browser (`determinism.e2e.ts`).
- Generative: seeded random valid formulas evaluate twice to an identical result, and a fuzz run of random
  byte strings through `compileFormula` never throws.
- Source scan: no `eval`, `Function`, `import(`, `globalThis`, `Date`, `Math.random`, `Intl`, `process`.
- Load: real engines against the paradigm packages and fixture (`apps/api/src/modules/systems`).

## Affected Modules

- New: `packages/formula`, `apps/api/src/modules/systems/registry.ts`, `tools/guard/src/bundle-check.ts`.
- `packages/systems/src/load.ts`, `semantics` untouched: port entry, `formula_cycle` code.
- `packages/systems/src/testing/conformance.ts`: optional validators, new check names.
- `apps/api/src/runtime.ts`: default catalog comes through the validated registry.
- `tools/guard/src/rules.ts`: `no-impure-engine-imports`.
- `apps/web/package.json`, `apps/api/package.json`: bundle check in `build`.

## Out of Scope

Dice (09). Effects and binding names to a context (11). Rendering and recomputation (15). Everything P1
and P2 in the PRD.
