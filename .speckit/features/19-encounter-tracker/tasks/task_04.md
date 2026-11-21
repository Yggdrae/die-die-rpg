# Task 04: Tracker, start form, player view, and Session Mode quick action

Status: completed (2026-11-06)

## Scope

- `apps/web/src/features/encounters`: `EncounterWorkspace`, `EncounterHost`, `encounter-source.ts`,
  `ENCOUNTER_SESSION_QUICK_ACTIONS`. Registered in the app shell's `SESSION_QUICK_ACTIONS`.

## Acceptance Criteria

- The tracker, the start form, and the player view render from declarations for all three packages (static markup).
- Session Mode still imports no feature 19 code.

## Verification

```bash
bun test apps/web/src/features/encounters apps/web/src/features/sessions
```
