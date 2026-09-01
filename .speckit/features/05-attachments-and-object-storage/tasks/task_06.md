# Task 06: Deletion reconciliation and export manifest

Status: pending. Depends on tasks 02–05.

## Scope

- Implement versioned metadata tombstone and 30-day purge scheduler.
- Add idempotent object/metadata reconciliation and orphan/missing-object diagnostics.
- Register P0 manifest-only `ExportableModule` contribution.
- Test sync watermark/reference gates, campaign deletion, and forbidden export fields.

## Acceptance Criteria

- Delete returns without inline object removal and denies new read URLs immediately.
- Purge waits for retention, watermark, and retained-reference conditions.
- Export contains ready metadata/checksums/Visibility and no bytes, keys, URLs, or local state.

## Verification

```bash
bun test packages/attachments
bun run typecheck
```

