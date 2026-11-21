# Task 02: Target state, operations, guards, overlay

Status: completed (2026-11-01)

## Scope

- `TargetState`, `PlannedOperation`, `applyPlannedOperations`, `projectTargetState`, `clampTargetState`.

## Acceptance Criteria

- Path grammar refuses host names; guards refuse; missing numbers read as 0; merges commute for deltas.

## Verification

```bash
bun test packages/actions
```
