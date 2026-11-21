# Task 05: Operator-Issued Password Recovery

## Goal

Restore a local account through a trusted-host, single-use recovery flow without granting recovery
authority to campaign roles.

## Dependencies

- Tasks 03 and 04

## Scope

### Change

- Implement operator-only recovery issuance through the approved local command adapter.
- Print the raw token once; persist only its digest and safe operator reference.
- Implement atomic token consumption, password replacement, and the approved session-revocation
  policy.
- Record issuance through `AuditRecorder` and make audit degradation observable per its contract.
- Test expired, used, revoked, unknown, and concurrent consumption behavior.

### Do Not Change

- No HTTP issuance route, campaign-role authorization, email delivery, or operator-selected
  password.
- No plaintext token in logs or retained command output beyond the issuance boundary.

## Acceptance Criteria

- [x] Only trusted local process invocation can issue a recovery token.
- [x] Exactly one concurrent consumer changes the password and consumes the token.
- [x] Every unusable token fails closed without password mutation.
- [x] The approved existing-session policy is applied atomically with recovery.
- [x] Campaign `owner` and `gm` status grants no issuance capability.

## Verification

```bash
bun test packages/identity apps/api/src/modules/identity
bun run check
bun run typecheck
```
