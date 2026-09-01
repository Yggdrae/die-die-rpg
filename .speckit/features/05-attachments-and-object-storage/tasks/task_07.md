# Task 07: Attachment security and acceptance suite

Status: pending. Depends on tasks 03–06.

## Scope

- Automate upload-to-preview, offline pinned campaign, estimate accuracy, and unavailable fallback BDD flows.
- Add security tests for MIME spoofing, oversized uploads, URL leakage, CORS, XSS, and authorization bypass.
- Exercise provider failure, lost finalization acknowledgement, cleanup backlog, and missing objects.
- Verify full repository gates and document only evidenced configuration.

## Acceptance Criteria

- Fixture upload reaches preview under 30 seconds on the accepted network profile.
- Zero attachment paths serve without authorization or execute in application origin.
- All P0 BDD scenarios have automated or explicitly profiled evidence.

## Verification

```bash
bun run check
bun run typecheck
bun test
bun run guard
bun run build
```

