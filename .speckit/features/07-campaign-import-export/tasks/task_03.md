# Task 03: Export registry and consistent orchestrator

Status: pending. Depends on task 02.

## Scope

- Implement unique contributor registry and conformance kit.
- Orchestrate sorted contributors under one repeatable snapshot/cursor and stream ZIP output.
- Add system/module locks, attachment manifest, secret/forbidden-field scanning, and unknown chunks.
- Test contributor failure, deterministic ordering, and no internal feature imports.

## Acceptance Criteria

- A new registered contributor appears without orchestrator changes.
- Export cannot mix authority states or offer a partial file after contributor failure.
- P0 package contains no credentials, audit, binary bytes, object/sync secrets.

## Verification

```bash
bun test packages/campaign-portability
bun run guard
```

