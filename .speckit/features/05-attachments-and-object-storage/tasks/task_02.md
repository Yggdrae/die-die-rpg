# Task 02: Attachment schema, storage port, and lifecycle

Status: pending. Depends on task 01.

## Scope

- Create `packages/attachments`, public module contracts, ObjectStorage port/adapter, and TypeBox schemas.
- Add metadata migration/indexes/checks and lifecycle repositories from `_db.md`.
- Implement file policy, safe filename/key generation, status transitions, and idempotency primitives.
- Add unit/PostgreSQL tests.

## Acceptance Criteria

- Binary bytes cannot enter PostgreSQL or public metadata payloads.
- Only ready/nondeleted rows resolve as attachments.
- Database and boundary reject unsupported MIME, unsafe filename, invalid checksum, and >25 MB.

## Verification

```bash
bun test packages/attachments
bun run typecheck
```

