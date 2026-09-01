# Task 07: Authorization guard and security acceptance

Status: pending. Depends on tasks 04–06.

## Scope

- Extend guard rules/fixtures for local role checks, direct membership access, and unregistered content routes.
- Run BDD acceptance across API payloads, local databases, attachments, audit, and export.
- Add denial-telemetry aggregation tests without actor-level surveillance.
- Verify full repository gates.

## Acceptance Criteria

- Guard names the violating file/rule and sanctioned boundary.
- Validation campaign contains zero unauthorized GM-only/private rows on player devices.
- Every content class passes the shared matrix before route registration.

## Verification

```bash
bun run check
bun run typecheck
bun test
bun run guard
bun run build
```

