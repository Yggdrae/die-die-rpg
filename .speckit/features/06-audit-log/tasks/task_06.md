# Task 06: Contributor conformance, retention, and acceptance

Status: pending. Depends on tasks 02–05.

## Scope

- Add conformance inventory for every PRD-required P0 mutating contributor and renderer.
- Implement 365-day retention report-only job and watermark checks; enable deletion only after approval.
- Run offline atomicity, private-store, ordering, failure-isolation, and local-budget acceptance flows.
- Verify repository gates and no accidental audit export.

## Acceptance Criteria

- Missing required contributor registration fails CI.
- No user operation fails because audit storage/retention/rendering fails.
- Report-only retention names eligible rows without deleting before approval.

## Verification

```bash
bun run check
bun run typecheck
bun test
bun run guard
bun run build
```

