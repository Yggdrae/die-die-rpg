# Task 04: Account Creation, Login, Authentication, and Logout

## Goal

Implement local accounts and opaque server-side sessions as application use cases and an API
authentication adapter.

## Dependencies

- Task 03

## Scope

### Change

- Implement password hashing/verification and rehash-on-login using the frozen parameters.
- Implement atomic account creation plus initial session, duplicate-name handling, login, session
  authentication, and idempotent logout revocation.
- Generate high-entropy session credentials and persist only their digest.
- Add the Fastify authentication hook/decorator yielding `AuthenticatedUser` without trusting
  client role input.
- Add unit and PostgreSQL integration tests for the account/session BDD scenarios and redaction.

### Do Not Change

- No account recovery, membership authorization, P1 session listing, or HTTP route set.
- No account-enumerating invalid-login response.

## Acceptance Criteria

- [x] Signup creates user, binding, credential, and session in one transaction.
- [x] Valid login issues one expiring opaque credential; invalid login issues none.
- [x] Logout, expiry, and revocation immediately fail later authentication.
- [x] Passwords, hashes, raw session credentials, and digests never enter responses or logs.

## Verification

```bash
bun test packages/identity apps/api/src/modules/identity
bun run --filter @rpg/identity typecheck
bun run --filter @rpg/api typecheck
```
