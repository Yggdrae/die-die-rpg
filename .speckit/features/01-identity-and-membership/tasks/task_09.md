# Task 09: Membership Listing and Administration

## Goal

Implement server-authoritative member listing, campaign listing, removal, role change, and
ownership-transfer application use cases.

## Dependencies

- Tasks 06 and 07

## Scope

### Change

- Implement authorized campaign-member listing and self-only campaign listing.
- Implement removal using locked actor/target rows and the owner/GM authority matrix.
- Implement owner-only non-owner role changes and expose the task-07 ownership transfer use case.
- Increment membership version and preserve authored content on role/removal transitions.
- Record membership changes and publish provider-neutral revocation/change signals after commit.
- Add tests for the complete membership-administration BDD matrix.

### Do Not Change

- No client/offline membership writes, content deletion, `observer`, or direct feature 03/06
  infrastructure dependency.

## Acceptance Criteria

- [ ] Owner/GM removal permissions and GM self-removal match the frozen behavior.
- [ ] Sole owner cannot be removed; non-owner cannot change roles or transfer ownership.
- [ ] Role/removal changes increment version and affect fresh resolution immediately.
- [ ] Removed authored content remains.
- [ ] Lists return each current membership once and exclude tombstones.

## Verification

```bash
bun test packages/identity --timeout 30000
bun run --filter @rpg/identity typecheck
```
