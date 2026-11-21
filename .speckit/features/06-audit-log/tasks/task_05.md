# Task 05: Campaign and session audit interface

Status: completed (2026-10-27). No sessions feature exists yet (feature 18), so the session view is
reached by `sessionId` only.

## Scope

- Build campaign/session log views, cursor loading, actor/target filters, pending/partial markers.
- Render contributor descriptions and safe generic unknown events.
- Keep private view unavailable to non-GM roles.
- Add component/Playwright reconstruction and privacy tests.

## Acceptance Criteria

- [x] A GM can identify actor/time/before/after explanation for a fixture resource change.
- [x] Player sees no private/hidden row or misleading total.
- [x] Offline pending entries remain distinguishable from authority-accepted history.

## Verification

```bash
bun test apps/web/src/features/audit apps/api/src/modules/audit
bun run build
```

## Implementation

- `apps/web/src/features/audit/`:
  - `audit-model.ts`: online view (device-only pending/conflicted/rejected entries above API pages;
    total only from the API), offline view (replica log, partial marker, no total), generic local
    description (never raw values), `canViewPrivate` (GM-role UI hint), request paths.
  - `audit-api.ts`: page, `invalid_cursor`, safe 404 (`unavailable`), failure.
  - `AuditLog.tsx`: campaign/private tabs (private only for GM roles), actor/target filters,
    "Load older entries" by cursor, restart on `invalid_cursor`, offline/partial/pending markers.
  - `CampaignHistory.tsx`: dashboard "History" (lazy), member names and role hint from the member
    list; local reads through `useBrowserSync().readLocalAudit` (task 04 replica).
  - `e2e-harness.tsx` (Playwright only).
- Server stays authoritative: the private route answers the safe 404 to non-GM roles (task 03).

## Evidence (with `.env`, 2026-10-27)

- `bun test apps/web/src/features/audit apps/api/src/modules/audit`: 52 pass, 0 fail
  (`audit-model.test.ts` 6, `AuditLog.test.tsx` 4 new).
- `bun run test:e2e -- apps/web/e2e/audit.e2e.ts`: 7 pass — GM reads actor/time/"from 6 to 2" and
  the private log; player gets no private tab, no hidden row, total = visible rows, no private
  request or local private read; a client claiming GM gets the server 404 and nothing; offline
  pending vs accepted labels, partial marker, no total, no raw values; online device entry labeled
  above authority history; cursor paging and invalid-cursor restart; actor filter narrows.
- Real renderer text through the real route: `apps/api/src/audit-acceptance.integration.test.ts`
  ('Renamed the campaign from "Draft" to "Ashen Road".', task 06).
- `bun run build`: api and web exit 0.

## Gaps

- No session list exists (feature 18); the session route is exercised by API tests only.
- Offline entries use the generic description; registered renderers run on the server.
