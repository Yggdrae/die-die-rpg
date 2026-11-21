# ADR-001: System packages are declarative data

Status: accepted, 2026-10-30.

## Context

`PRD.md` s.15 and s.75 treat packages as untrusted input, including first-party ones. Mechanics must run offline,
at the table, on every device. `PRD.md` s.25 keeps an executable plugin runtime open for V3.

## Decision

An MVP package is plain data: objects, arrays, strings, finite numbers, booleans, null. Loading never evaluates
it. A value that could run or reach shared prototypes is refused before the schema reads anything. Dice, formula,
and effect content is inert text that features 09, 10, and 11 alone interpret, through restricted languages.

## Alternatives

- **Executable plugins or a sandbox (QuickJS, WebAssembly).** Express anything, but add a runtime, a permission
  model, and resource limits for a need Cairn and Fate have not shown. Left for V3.
- **TypeScript packages compiled in.** First-party only, and a package could import anything; review would be the
  only control.

## Consequences

A mechanic that cannot be declared is a contract finding, which is the point of proving both MVP systems early.
Adding an executable runtime later is additive: it would be a new package kind, not a change to this one.
