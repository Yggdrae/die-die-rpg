# Task 02: Bounded rpgpack format and package inspector

Status: pending.

## Scope

- Create `packages/campaign-portability` and TypeBox schemas for manifest, locks, reports, and chunks.
- Implement deterministic ZIP writer/reader abstraction and every `_db.md` size/path/checksum limit.
- Reject malformed/duplicate/traversal/symlink/bomb/deep JSON input before extraction/write.
- Add property/fuzz fixtures and canonical checksum tests.

## Acceptance Criteria

- Valid package layout/checksums are deterministic.
- Every invalid-package BDD defect changes no domain state.
- Untrusted entry names/content never become filesystem paths or executable data.

## Verification

```bash
bun test packages/campaign-portability
bun run typecheck
```

