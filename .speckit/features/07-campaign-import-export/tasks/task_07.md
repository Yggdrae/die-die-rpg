# Task 07: Portability UI, fuzzing, and round-trip acceptance

Status: pending. Depends on tasks 04–06.

## Scope

- Build export warning/progress/download and import validation/result/warning interfaces.
- Run campaign round trip across every registered P0 contributor and visibility mode.
- Fuzz ZIP/JSON boundaries and test unavailable system, unknown chunks, rollback, and deliberate duplicate import.
- Verify guard independence and full repository gates.

## Acceptance Criteria

- Round trip preserves recognized logical counts, exact pins, and never widens visibility.
- Unknown/unrestored data is explicitly reported; no silent discard.
- Orchestrator contains no imports of content-feature internals.

## Verification

```bash
bun run check
bun run typecheck
bun test
bun run guard
bun run build
```

