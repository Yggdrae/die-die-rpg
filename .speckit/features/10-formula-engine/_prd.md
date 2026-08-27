# PRD: Formula Engine

Source: `PRD.md` s.17, s.18, s.24, s.25, s.75, s.91.
Track: B. Depends on: contracts from feature 00 only. Pure package, no persistence, no infrastructure.

## Problem

Systems need computed values. A derived defence, a carrying capacity from an attribute, a
condition that triggers when a resource hits zero. Those expressions come from a system package,
which `PRD.md` s.75 classifies as untrusted input even when first-party.

The obvious implementation is to evaluate the string as JavaScript. `PRD.md` s.24 forbids it
explicitly, along with `eval`, `Function`, filesystem, network, timers, process, global objects,
and dynamic imports, and s.91 records the decision to use an AST interpreter instead. This
feature exists to make computed fields possible without giving package content a runtime.

## Goals

- A system package declares computed values without shipping code.
- Evaluation is total: it terminates, it is bounded, and it cannot reach anything outside its inputs.
- The same formula on two devices produces the same result, because offline clients compute
  independently and must not disagree (`PRD.md` s.52).
- A malformed or hostile formula is rejected at package validation, not discovered during a session.

## Non-Goals

- A general-purpose scripting language. Expressions only, no statements, loops, or definitions.
- Dice evaluation. Feature 09 owns it and stays independent (`PRD.md` s.20).
- Effect application or state mutation. Feature 11 owns them. A formula reads; it never writes.
- QuickJS or WebAssembly sandboxing. Explicitly excluded from MVP (`PRD.md` s.24), reconsidered
  only for executable plugins (`PRD.md` s.25, V3).
- User-authored formulas in the interface. MVP formulas come from system packages only.

## Users and Context

### Primary user

The three developers and, through them, system packages 12 and 13. There is no end-user surface
for authoring formulas in MVP.

### Secondary users

Feature 15, which renders computed fields, and feature 11, which evaluates conditions. Future
system authors (`PRD.md` s.6), whose eventual existence is the reason the restriction exists now
rather than later.

## User Stories

- As a system package, I want to declare a derived value from other fields, so that a sheet shows
  the number a player expects without hard-coded logic in the application.
- As a developer, I want a formula that cannot escape its inputs, so that a package is not a
  remote code execution surface.
- As a developer, I want a formula rejected at load with a precise error, so that a broken package
  never reaches a table.
- As a player, I want a computed field to update immediately when I change the field it depends on,
  offline.

## Functional Requirements

### P0 — MVP

- FR-001: Pipeline per `PRD.md` s.24: source, parser, AST, validator, restricted interpreter, result.
  Each stage is separately testable.
- FR-002: Supported expressions covering the `PRD.md` s.24 examples: arithmetic (`10 + ATTRIBUTE_A`,
  `level * 2`), comparison (`ATTRIBUTE_A > 10`, `RESOURCE_A <= 0`), and an allow-listed function
  set including `min` (`min(armor, 3)`).
- FR-003: Value types limited to number, boolean, and string comparison. No objects, no arrays,
  no functions as values, unless a named MVP system requires them.
- FR-004: Identifier resolution against a caller-supplied context only. The engine never reads
  a character, a store, or a global (`PRD.md` s.24).
- FR-005: Nothing outside the allow list is reachable: no `eval`, no `Function`, no filesystem,
  no network, no timers, no process, no global objects, no dynamic import (`PRD.md` s.24, s.75).
- FR-006: Execution limits per `PRD.md` s.24: maximum AST depth, maximum operation count,
  maximum source length, allow-listed functions, accepted types. Exceeding a limit is a typed
  failure, never a hang.
- FR-007: Determinism. The same source and the same context produce the same result on every
  platform, with no time, randomness, locale, or environment input (`PRD.md` s.24).
- FR-008: Static validation separated from evaluation, so feature 08 rejects a package containing
  an invalid formula at load (`PRD.md` s.16).
- FR-009: Typed failures rather than exceptions for expected conditions: unknown identifier,
  type mismatch, division by zero, limit exceeded. Uses the `Result` contract from feature 00.
- FR-010: Dependency extraction: given a formula, report the identifiers it reads, so feature 15
  recomputes only affected fields and can detect a circular dependency at load.
- FR-011: A published module API for validating and evaluating a formula, consumed by features
  08, 11, 15.

### P1 — Important

- FR-101: Additional functions (`max`, `floor`, `ceil`, `round`, `clamp`, `abs`) added when a
  named system package needs them, not before.
- FR-102: Conditional expressions, if an MVP or V1 system requires branching.

### P2 — Later

- FR-201: Isolated runtime for executable plugins, where QuickJS or WebAssembly becomes relevant
  (`PRD.md` s.25).
- FR-202: A formula authoring surface for a custom system builder (`PRD.md` s.74).

## Behavioral Constraints

- The interpreter is the security boundary and is treated as one. Every language addition is a
  deliberate widening reviewed as such (`PRD.md` s.75).
- No system-specific behaviour and no branch on system identity (`PRD.md` s.89).
- A formula is a read. It never mutates state, emits an event, or has any effect other than
  returning a value.
- Every path terminates. Operation and depth limits are enforced in the interpreter, not by
  a timeout, because a timeout is not available in a synchronous render path.
- Identical results across clients are required, since offline clients each compute locally and
  a disagreement would surface as a spurious conflict in feature 03.
- The language starts as small as the MVP systems require. Growth is driven by a named system,
  never by anticipation.

## Data and Privacy Considerations

- No persistence, no personal data, no network. The engine holds nothing.
- Failures must not include context values in messages that could be surfaced to a player, since
  a formula context may contain GM-only values.
- The evaluation context is supplied by the caller, so the caller controls what a formula can see.
  A GM-only value must not be placed in a player-side evaluation context.

## Success Signals

- Both MVP system packages express their computed fields with no engine change specific to either.
- Adversarial test corpus, including deep nesting, huge literals, unknown identifiers, and attempts
  at global access, produces typed failures and never a hang or an escape.
- Zero uses of `eval` or `Function` in the shipped bundle, asserted by build check (`PRD.md` s.75).
- A computed field on a sheet updates without a perceptible delay when its input changes.

## Rollout

Wave 2, Track B. Feature 15 builds computed fields against fixture formulas from feature 00 until
this ships. It has no runtime dependency on anything except feature 00 contracts, so it can be
pulled forward by whichever developer is free.

## Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Language grows toward general-purpose scripting | The security boundary in `PRD.md` s.24 and s.75 erodes one convenience at a time | Additions require a named system package that needs them; every addition reviewed as a security change |
| A limit is missing and a formula hangs a client mid-session | The session stops, which is the failure the offline design exists to prevent | All four limits from s.24 enforced in the interpreter (FR-006); adversarial corpus in CI |
| Cross-client result divergence | Spurious conflicts in feature 03, values that differ per device | Determinism requirement (FR-007) with cross-platform tests; no locale, time, or float-formatting dependence |
| Circular formula dependencies | Infinite recomputation in feature 15 | Dependency extraction (FR-010) and cycle detection at package load |
| Reaching for QuickJS or WebAssembly when a case looks hard | An MVP decision reversed under pressure without review (`PRD.md` s.24) | A case that cannot be expressed is a tech spec finding, escalated, not solved locally with a runtime |

## ADR Candidates

- AST interpreter with an allow-listed language, versus a sandboxed JavaScript runtime
  (`PRD.md` s.24, s.91). Registered in s.91; worth an ADR because s.25 keeps the alternative alive
  for a future scenario and the boundary between the two needs to be written down.

## Open Questions

- TODO: The exact allow-listed function set for MVP, derivable only from features 12 and 13 in draft.
- TODO: Numeric semantics: integer or floating point, and rounding rules. Determinism across
  clients depends on this being explicit.
- TODO: Whether string comparison is needed in MVP at all, or only numeric and boolean.
- TODO: Concrete limit values for depth, operation count, and source length.
