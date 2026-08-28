# Task 08: Invitation Lifecycle and Acceptance

## Goal

Implement revocable, expiring, single-use invitations that create exactly one scoped membership.

## Dependencies

- Tasks 04 and 06

## Scope

### Change

- Add invitation migration, indexes, lifecycle constraints, and internal repository.
- Implement safe public preview, owner/GM issuance and revocation, and one-time raw-token return.
- Implement acceptance with row locking, database-time expiry, membership insert/reactivation, and
  token consumption in one transaction.
- Reject existing active membership, `owner`, `observer`, unauthorized issuers, and unusable tokens.
- Add authorization and concurrency tests for all invitation BDD scenarios.

### Do Not Change

- No email targeting/delivery, offline acceptance, role change of an existing active member, or
  cross-campaign grant.

## Acceptance Criteria

- [ ] Only authorized roles issue/revoke invitations under the frozen revocation policy.
- [ ] Raw invitation token is returned once and never stored or logged.
- [ ] Exactly one concurrent acceptance creates/reactivates membership and consumes the token.
- [ ] Preview exposes only the approved public fields.
- [ ] Acceptance grants exactly the invitation role in exactly one campaign.

## Verification

```bash
bun test packages/identity --timeout 30000
bun run check
bun run typecheck
```
