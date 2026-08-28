# Task 05: Campaign and session audit interface

Status: pending. Depends on tasks 03–04.

## Scope

- Build campaign/session log views, cursor loading, actor/target filters, pending/partial markers.
- Render contributor descriptions and safe generic unknown events.
- Keep private view unavailable to non-GM roles.
- Add component/Playwright reconstruction and privacy tests.

## Acceptance Criteria

- A GM can identify actor/time/before/after explanation for a fixture resource change.
- Player sees no private/hidden row or misleading total.
- Offline pending entries remain distinguishable from authority-accepted history.

## Verification

```bash
bun test apps/web/src/features/audit apps/api/src/modules/audit
bun run build
```

