# Task 06: Real-stack end-to-end

Status: completed (2026-11-03)

## Scope

- `apps/web/e2e/characters.e2e.ts` over PostgreSQL, PowerSync, and the real API composition.

## Acceptance Criteria

- A player creates a character, taps a resource offline, sees it at once, and the queue drains once.
- The GM sees the character; another player's replica holds none.
- A declared action rolls from the sheet and its plan applies.

## Verification

```bash
bun x playwright test apps/web/e2e/characters.e2e.ts
```
