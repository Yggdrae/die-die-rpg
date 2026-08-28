# Task 02: Campaign PostgreSQL schema and owner invariant

Status: pending. Depends on task 01 and feature 01 membership schema.

## Scope

- Add the four `_db.md` tables, indexes, checks, and forward-only migration.
- Add feature 01 campaign foreign keys, partial owner uniqueness, and deferred owner constraint trigger.
- Implement transaction helpers for create and ownership transfer with stable row locking.
- Add PostgreSQL concurrency/invariant tests.

## Acceptance Criteria

- Creation commits campaign, pins, settings, and exactly one owner or nothing.
- Commit rejects every active ownerless/multi-owner campaign state.
- Migration does not expose campaign schema internals outside `packages/campaigns`.

## Verification

```bash
bun test packages/campaigns
bun run db:migrate
bun run typecheck
```
