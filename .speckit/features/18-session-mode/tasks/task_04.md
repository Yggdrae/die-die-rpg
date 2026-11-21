# Task 04: Session screen, player view, and command palette

Status: completed (2026-11-04)

## Scope

- `apps/web/src/features/sessions`: `session-source.ts`, `SessionWorkspace` (GM regions: party, current scene, quick
  actions, GM notes, log; player view), `CommandPalette`, mounted in `CampaignDashboard` with the shell's quick actions.

## Acceptance Criteria

- Every quick action and palette operation runs without leaving the screen.
- No import from `features/content`, `features/handouts`, or any feature 19 code inside `features/sessions`.
- The player view renders no GM control.

## Verification

```bash
bun test apps/web/src/features/sessions
```
