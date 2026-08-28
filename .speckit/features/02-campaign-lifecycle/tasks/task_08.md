# Task 08: Campaign boundary guard and acceptance flows

Status: pending. Depends on tasks 04–07.

## Scope

- Extend guard rules/negative fixtures for external campaign schema access and system-ID branches.
- Add end-to-end creation, authorization, pin/update, offline, and deletion acceptance flows.
- Verify audit/context/owner integration through public boundaries.
- Update only repository operational docs required by actual commands/configuration.

## Acceptance Criteria

- Guard fails on direct/deep campaign persistence access outside the package.
- BDD P0 scenarios have automated coverage or an explicit manual performance gate.
- Full repository gates pass with no P1 behavior enabled accidentally.

## Verification

```bash
bun run check
bun run typecheck
bun test
bun run guard
bun run build
```

