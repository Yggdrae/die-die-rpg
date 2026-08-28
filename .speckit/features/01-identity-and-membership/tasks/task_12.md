# Task 12: Audit and Sync Revocation Boundaries

## Goal

Connect committed identity changes to audit and synchronization without making either integration
the source of authorization truth.

## Dependencies

- Task 09
- Feature 03 revocation/cache contract
- Feature 06 `AuditRecorder` integration contract

## Scope

### Change

- Adapt recovery issuance and membership create/remove/role/ownership changes to `AuditRecorder`.
- Adapt membership role/removal commits to feature 03's provider-neutral connected-access and
  local-cleanup signal.
- Expose only current-user membership cache fields approved by `_db.md`.
- Test degraded delivery, retry observability, server denial after revocation, reconnect
  replacement, tombstone handling, and credential-table publication exclusion.

### Do Not Change

- No PowerSync/SQLite ownership inside feature 01, no rollback of committed membership because a
  notification fails, and no finite tombstone purge before feature 03 defines acknowledgment.
- No credential, session, invitation, recovery, or unrelated-user data in sync publication.

## Acceptance Criteria

- [ ] Server authorization rejects removed membership regardless of notification state.
- [ ] Connected access is revoked and cached campaign cleanup is requested after commit.
- [ ] Higher server membership version replaces cached role; tombstone removes cached access.
- [ ] Audit/sync failures are observable and retryable without restoring membership.
- [ ] Publication/export checks exclude every credential-bearing table and field.

## Verification

```bash
bun test packages/identity --timeout 30000
bun run guard
bun run typecheck
```
