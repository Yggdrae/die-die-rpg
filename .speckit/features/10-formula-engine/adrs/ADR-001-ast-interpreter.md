# ADR-001: AST interpreter with an allow-listed language

Status: accepted (2026-10-31, delegated by the owner).

## Context

System packages are untrusted input (`PRD.md` s.75) and need computed values. `PRD.md` s.24 forbids
evaluating them as JavaScript and excludes QuickJS and WebAssembly from MVP; s.91 records the AST
interpreter. `PRD.md` s.25 keeps a sandboxed runtime alive for future executable plugins.

## Decision

Formulas are parsed by our own parser into a small AST and evaluated by our own interpreter. The
language is integers, booleans, four arithmetic operators, comparisons, parentheses, and `min`.

## Alternatives

- **Sandboxed JavaScript (QuickJS, WebAssembly).** Rejected for formulas: a whole runtime and its
  escape surface to compute `level * 2`, and floating point would come with it. It remains the likely
  answer for executable plugins in V3, which are a separate concept with a separate permission manifest.
- **`new Function` with a scrubbed scope.** Rejected: forbidden by s.24, and scope scrubbing has no
  sound history.
- **An expression library.** Rejected: a dependency in the security boundary, with a wider language than
  we need and float semantics.

## Boundary With Plugins

A formula reads a caller-supplied map and returns a value. If a case cannot be expressed, that is a
techspec finding and a reviewed widening driven by a named system. It is never a reason to reach for a
runtime. A plugin would run code; a formula never does.

## Consequences

Every language addition is a security change. Cross-client determinism comes from integers. Some system
ideas need a new function, and that is the intended friction.
