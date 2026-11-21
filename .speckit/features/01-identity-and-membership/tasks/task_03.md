# Task 03: PostgreSQL Tooling and Core Identity Migration

## Goal

Install the approved persistence tooling and create the authoritative core identity schema with
transactional adapters.

## Dependencies

- Tasks 01 and 02

## Scope

### Change

- Add the approved migration/query dependencies and configuration.
- Add forward-only migrations for users, identity bindings, password credentials, sessions, and
  recovery tokens with `_db.md` constraints and indexes.
- Implement transaction, database-time, and typed query primitives inside identity infrastructure.
- Add repositories for those records; redact all credential/hash fields from diagnostics.
- Add PostgreSQL integration tests for unique normalized usernames, rollback without orphan rows,
  session expiry/revocation, and constraint mapping.

### Do Not Change

- No campaign, invitation, or membership tables until their foreign-key owner is coordinated.
- No cleanup job in this task; the frozen retention floors are schema/test inputs and cleanup
  execution is separately scoped.
- No raw credentials in fixtures, snapshots, query logs, or errors.

## Acceptance Criteria

- [x] A clean database migrates forward using one documented command.
- [x] Concurrent duplicate account inserts yield one user and no orphan dependent rows.
- [x] Active-session lookup uses digest plus database time and excludes expired/revoked rows.
- [x] Schema and adapters match `_db.md`; package internals do not leak through exports.

## Verification

```bash
bun run check
bun run typecheck
bun test packages/identity --timeout 30000
```

Run against a fresh PostgreSQL database from the documented local stack.
