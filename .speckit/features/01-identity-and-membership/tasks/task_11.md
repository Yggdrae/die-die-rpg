# Task 11: Web Account and Invitation Flows

## Goal

Provide the P0 browser flows from account creation through campaign entry, including invitation
continuation across authentication.

## Dependencies

- Task 10

## Scope

### Change

- Add signup, login, logout, and password-recovery-consumption screens and routing.
- Add safe invitation preview and preserve only the invitation credential through signup/login in
  the approved short-lived navigation/cookie mechanism.
- Complete invitation acceptance and navigate to the returned campaign destination.
- Add member/invitation list and owner/GM administration UI required by P0.
- Add component/integration tests for error, expiry, revoked access, and secret non-disclosure.

### Do Not Change

- No email, session-management UI, profile/avatar work, offline mutation, or locally inferred
  authorization.
- Do not persist session or recovery credentials in general-purpose browser storage.

## Acceptance Criteria

- [x] Signup/login/logout/recovery surfaces map stable API outcomes without revealing secrets.
- [x] A logged-out invitation survives signup or login and is accepted exactly once.
- [x] Successful acceptance lands in the invited campaign.
- [x] UI hides unavailable actions for usability while the server remains authoritative.
- [x] Invitation-to-campaign and signup-to-first-campaign flows support PRD timing goals.

## Verification

```bash
bun test apps/web
bun run --filter @rpg/web typecheck
bun run --filter @rpg/web build
```
