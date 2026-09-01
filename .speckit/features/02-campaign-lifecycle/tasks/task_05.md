# Task 05: Creation wizard and campaign list

Status: completed.

## Scope

- Build the feature-scoped React wizard, system list/search, review, and campaign list.
- Render only manifest declarations; skip empty option/module steps.
- Reset dependent state when system changes and persist no abandoned draft.
- Add component and Playwright happy/failure-path tests.

## Acceptance Criteria

- A fixture system unknown to the feature completes the same flow.
- Invalid/empty steps cannot produce partial campaign state.
- Campaign creation meets the three-minute user-time acceptance scenario on the test profile.

## Verification

```bash
bun test apps/web/src/features/campaigns
bun run build
```
