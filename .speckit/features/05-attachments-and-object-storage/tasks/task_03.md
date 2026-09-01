# Task 03: Authorized upload and verified finalization

Status: pending. Depends on task 02 and feature 04.

## Scope

- Add upload-request/finalize application services and Fastify routes with TypeBox.
- Require fresh target authorization before pending row/grant.
- Verify HEAD size, streamed SHA-256, and actual file signature before ready.
- Implement 24-hour abandoned upload cleanup and retry/idempotency tests.

## Acceptance Criteria

- No unauthorized/invalid request receives an upload destination.
- Pending/mismatched files never list or receive read URLs.
- Identical finalize retry returns one attachment; mismatched retry changes nothing.

## Verification

```bash
bun test packages/attachments apps/api/src/modules/attachments
bun run typecheck
```

