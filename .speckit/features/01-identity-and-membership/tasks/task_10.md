# Task 10: Fastify Identity Routes and Request Security

## Goal

Expose the P0 identity use cases through typed, thin Fastify routes with secure cookie and request
handling.

## Dependencies

- Tasks 04, 05, 08, and 09

## Scope

### Change

- Register every P0 route listed in `_techspec.md`; recovery issuance remains operator-only.
- Apply TypeBox request/response schemas and the shared `ApiError` mapping.
- Configure opaque session cookie flags, clearing, origin/CSRF protection, credential size limits,
  and rate limits for login/token endpoints.
- Return `unauthenticated`, generic unusable-token, and `not_found_or_forbidden` errors without
  leaking existence or internal details.
- Add route contract/security tests and secret-log scanning.

### Do Not Change

- No business rule in handlers, client-supplied role, P1 routes, email, or new global error shape.

## Acceptance Criteria

- [ ] Route schemas reject malformed/oversized input before use cases run.
- [ ] Production cookie is `HttpOnly`, `Secure`, and `SameSite=Lax`; logout clears it.
- [ ] State-changing cookie routes enforce the approved origin/CSRF policy.
- [ ] Authentication and token endpoints are rate limited and enumeration resistant.
- [ ] Responses/logs never contain passwords, hashes, digests, or unintended raw credentials.

## Verification

```bash
bun test apps/api
bun run --filter @rpg/api typecheck
bun run check apps/api packages/identity
```
