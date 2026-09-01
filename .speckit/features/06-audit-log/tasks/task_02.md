# Task 02: Non-blocking recorder and mutation envelope

Status: pending. Depends on task 01 and feature 03 durable envelope.

## Scope

- Implement `AuditRecorder` adapter with stable event/origin mutation IDs.
- Atomically attach validated audit payload to local/authority mutation envelopes.
- Add repair/dead-letter diagnostics for catastrophic audit insertion failures.
- Test retry, rejection, lost acknowledgement, and unavailable audit adapter.

## Acceptance Criteria

- Audit outage never rejects an otherwise valid user mutation.
- Retry creates one accepted event; rejected mutation creates no accepted history.
- Every gap/dead letter is observable without logging payload content.

## Verification

```bash
bun test packages/audit packages/sync
bun run typecheck
```

