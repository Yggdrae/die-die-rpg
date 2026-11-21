# BDD: Formula Engine

Source: `_prd.md`, `PRD.md` s.24, s.75, s.91. P0 only. "Compile" is parse plus static validation;
"context" is the name-to-value map the caller supplies.

## Language

### Scenario Outline: A formula computes its value

**Given** the context `{ ATTRIBUTE_A: 12, RESOURCE_A: 0, level: 3, armor: 5, flag: true }`  
**When** `<formula>` is evaluated  
**Then** the result is `<result>`

| formula | result |
| --- | --- |
| `10 + ATTRIBUTE_A` | 22 |
| `level * 2` | 6 |
| `min(armor, 3)` | 3 |
| `ATTRIBUTE_A > 10` | true |
| `RESOURCE_A <= 0` | true |
| `-(level - 5) * 2` | 4 |
| `7 / 2` | 3 |
| `-7 / 2` | -4 |
| `flag == true` | true |
| `level != 3` | false |

### Scenario Outline: A formula outside the language is rejected at compile

**When** `<source>` is compiled  
**Then** compiling fails with `<code>`  
**And** nothing is evaluated

| source | code |
| --- | --- |
| `` (empty) | syntax |
| `1 +` | syntax |
| `1.5 + 2` | syntax |
| `0x10` | syntax |
| `1e3` | syntax |
| `"text" == name` | syntax |
| `a = 1` | syntax |
| `a < b < c` | syntax |
| `actor.level` | syntax |
| `a[0]` | syntax |
| `a; b` | syntax |
| `max(1, 2)` | unknown_function |
| `min(1)` | arity |
| `1 + true` | type_mismatch |
| `min(true, 1)` | type_mismatch |
| `(1 < 2) + 1` | type_mismatch |
| `x / 0` | division_by_zero |
| `constructor` | forbidden_identifier |
| `__proto__` | forbidden_identifier |

## Failures Are Typed

### Scenario Outline: An expected failure at evaluation is a value, not an exception

**Given** a compiled formula and a context with <condition>  
**When** it is evaluated  
**Then** the result is a failure with code `<code>`  
**And** nothing is thrown

| condition | code |
| --- | --- |
| an identifier the context does not hold | unknown_identifier |
| a text value where a number is required | invalid_context_value |
| a fractional, infinite, or unsafe number | invalid_context_value |
| a boolean where a number is required | type_mismatch |
| a divisor that evaluates to zero | division_by_zero |
| a product past the safe integer range | limit_exceeded |

### Scenario: A failure message never carries a context value

**Given** a context whose values are recognizable secrets  
**When** any failure above is produced  
**Then** its message contains none of those values

## Containment

### Scenario Outline: Hostile input fails typed, never hangs, never escapes

**When** the engine receives <input>  
**Then** it returns a failure in bounded time  
**And** no global, prototype, or host object is read or changed

| input |
| --- |
| a source past the length limit |
| parentheses nested past the depth limit |
| unary minus repeated past the depth limit |
| a sum with more operations than the limit |
| an integer literal past the safe integer range |
| an identifier naming `globalThis`, `process`, `eval`, `Function`, `import`, `require` |
| a call to any of those names |
| a hand-built syntax tree with an unknown node, an unknown function, or a cycle |
| a context with an accessor, or a value only on its prototype |

### Scenario: Evaluation cannot be made to run code

**Given** source text containing JavaScript  
**When** it is compiled and evaluated  
**Then** no JavaScript runs  
**And** the shipped bundle contains no `eval` and no `Function`, asserted by the build

## Determinism

### Scenario: The same input gives the same result everywhere

**Given** a published table of formulas, contexts, and results  
**When** it runs in Bun and in a browser  
**Then** every result matches the table exactly

### Scenario: Negative zero never appears

**When** `0 * -1` is evaluated  
**Then** the result is `0`, not negative zero

## Dependencies

### Scenario: A formula reports what it reads

**When** `min(armor, 3) + level + armor` is compiled  
**Then** its dependencies are exactly `armor`, `level`, in sorted order

### Scenario: A dependency cycle refuses the set

**Given** named formulas where `a` reads `b` and `b` reads `a`  
**When** the set is checked  
**Then** the cycle is reported, naming `a` and `b`  
**And** a set with no cycle, including a shared dependency, reports nothing

## At Package Load

### Scenario: A bad formula refuses the whole system package

**Given** a package holding a formula the engine rejects, at any depth, including an effect parameter  
**When** the registry loads it through the engine's validators  
**Then** loading fails with `invalid_expression` at that path

### Scenario: A package with a cycle among its computed values is refused

**Given** a package whose computed fields read each other  
**When** the registry loads it  
**Then** loading fails with `formula_cycle`, naming the keys

### Scenario: Every expression the contract's two invented systems declare compiles

**Given** the two paradigm packages and the fixture package  
**When** the registry loads them through the engines' validators  
**Then** they load with no change to the engine specific to either

## Traceability

| PRD | Scenarios |
| --- | --- |
| FR-001 | Compile rejects; evaluate computes (each stage has its own tests) |
| FR-002 | A formula computes its value |
| FR-003 | A formula outside the language; typed failures |
| FR-004, FR-005 | Containment; Evaluation cannot run code |
| FR-006 | Hostile input |
| FR-007 | Determinism |
| FR-008 | At Package Load |
| FR-009 | Failures Are Typed |
| FR-010 | Dependencies |
| FR-011 | At Package Load; published API in `_techspec.md` |
