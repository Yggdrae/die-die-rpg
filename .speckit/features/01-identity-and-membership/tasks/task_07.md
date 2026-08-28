# Task 07: Atomic Campaign Ownership Integration

## Goal

Guarantee every committed campaign has exactly one active owner from creation through transfer.

## Dependencies

- Task 06
- Feature 02 campaign persistence and its approved owner-invariant design

## Scope

### Change

- Implement the deferred cross-table invariant selected with feature 02.
- Implement `CampaignMembershipWriter.createOwner` inside the caller's campaign transaction.
- Implement ownership transfer with stable row locking and the approved former-owner outcome.
- Add PostgreSQL concurrency tests for create/rollback, zero/multiple-owner rejection, sole-owner
  removal rejection, and atomic transfer.

### Do Not Change

- No direct feature-02 internal import; integrate through its transaction contract.
- No application-only owner invariant and no temporary committed ownerless campaign state.

## Acceptance Criteria

- [ ] Campaign creation and initial owner membership commit or roll back together.
- [ ] Database enforcement rejects zero or multiple active owners at commit.
- [ ] Transfer never exposes an invalid committed owner count under concurrent requests.
- [ ] Only the current owner can transfer to a current member.

## Verification

```bash
bun test packages/identity --timeout 30000
bun run guard
bun run typecheck
```
