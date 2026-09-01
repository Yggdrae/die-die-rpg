# Task 06: Membership Persistence and Actor Resolution

## Goal

Persist campaign membership and make `ActorResolver` the sole authoritative role lookup.

## Dependencies

- Task 03
- Feature 02 campaign table migration or an approved joint migration boundary

## Scope

### Change

- Add the membership migration after the campaign foreign-key target is available, including the
  composite key, role check, version, removal tombstone, and partial owner index from `_db.md`.
- Implement internal membership reads/writes and `ActorResolver`.
- Implement current-member and current-user campaign queries with pagination primitives.
- Add contract/integration tests for active, removed, reserved-role, and client-supplied-role cases.

### Do Not Change

- No general repository export, offline write path, PowerSync adapter, or owner creation outside
  `CampaignMembershipWriter`.
- Do not claim the exactly-one-owner invariant complete; task 07 owns its cross-table enforcement.

## Acceptance Criteria

- [ ] Active membership resolves one `ActorRef`; absent or removed membership returns
  `membership_not_found`.
- [ ] Client-supplied roles cannot affect resolution.
- [ ] `observer` cannot be persisted and owner uniqueness is enforced at least as "at most one."
- [ ] Removed rows remain tombstones and are excluded from current lists.

## Verification

```bash
bun test packages/identity --timeout 30000
bun run --filter @rpg/identity typecheck
```
