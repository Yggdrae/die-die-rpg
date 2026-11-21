# Task 03: Device reveal and the handout screen

Status: completed (2026-11-03)

## Scope

- `EntityLocalRepository.changeVisibility` over an unaudited repository. `visibilityChange` is transport-only on the
  device and in the browser sync store.
- `apps/web/src/features/handouts`: model, `HandoutsWorkspace` (prepare, preview, reveal with named recipients,
  hide again, player reader), `HandoutRevealHost`, `HANDOUT_SESSION_QUICK_ACTIONS`. Mounted on the dashboard.

## Acceptance Criteria

- The confirm button names the recipients, and nothing is confirmable without one.
- The GM sees who has each handout and what waits to be sent. Players see titles and text only.

## Verification

```bash
bun test apps/web/src/features/handouts packages/content/src/offline.test.ts
```
