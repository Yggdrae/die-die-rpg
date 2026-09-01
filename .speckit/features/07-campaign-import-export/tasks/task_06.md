# Task 06: Atomic import planner and coordinator

Status: pending. Depends on tasks 01–03 plus feature 01/02 and required contributor adapters.

## Scope

- Add import-job/preserved-chunk migrations and pre-write plan validation.
- Require exact installed system, build deterministic ID map, and create importer as sole owner.
- Invoke recognized contributors in one opaque transaction; preserve unknown chunks bounded/opaque.
- Roll back on any contributor failure and retain safe warnings/report for 90 days.

## Acceptance Criteria

- Failed import leaves no campaign, owner, contributor row, or preserved chunk.
- Missing system blocks before write and never substitutes.
- Unknown chunks survive canonical round trip and targeted unmapped visibility narrows to `gm_only` with warning.

## Verification

```bash
bun test packages/campaign-portability packages/campaigns packages/identity
bun run typecheck
```

