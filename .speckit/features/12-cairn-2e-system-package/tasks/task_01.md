# Task 01: Package, tests, and installation

Status: completed (2026-11-01)

## Scope

- `systems/` package file, with no code.
- Real-engine conformance and each mechanic played through the planner, in `systems/packages.test.ts`.
- Served through the validated registry.

## Acceptance Criteria

- Conformance passes with every engine, with no exception.
- Generic code names no system, by the guard.

## Verification

```bash
bun test systems
bun run guard
```
