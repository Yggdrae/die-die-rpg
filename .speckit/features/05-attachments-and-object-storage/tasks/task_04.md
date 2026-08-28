# Task 04: Authorized reads and safe rendering

Status: pending. Depends on tasks 02–03 and feature 04.

## Scope

- Implement list/resolve routes and five-minute signed read grants after fresh Decisions.
- Build inert image and sandboxed/separate-origin PDF viewer behavior.
- Make hidden/missing resolution indistinguishable and redact URL/key/log data.
- Test expiry, direct identifier probes, deletion/visibility changes, and active malformed content.

## Acceptance Criteria

- No URL is issued without current authorization.
- Leaked URLs expire and cannot be renewed after access loss.
- Uploaded content cannot access application data/session credentials.

## Verification

```bash
bun test packages/attachments apps/api/src/modules/attachments apps/web/src/features/attachments
bun run build
```

