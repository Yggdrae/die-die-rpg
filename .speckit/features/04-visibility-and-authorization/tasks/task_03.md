# Task 03: Versioned visibility mutation service

Status: pending. Depends on tasks 01–02.

## Scope

- Implement owner-adapter mutation flow, target membership checks, normalization, and expected versions.
- Support additive reveal, idempotent duplicate reveal, and un-reveal to `gm_only` when empty.
- Enqueue audit events through the mutation envelope.
- Add adapter contract and PostgreSQL normalization/concurrency tests.

## Acceptance Criteria

- Non-member targets and unauthorized actors leave records unchanged.
- Concurrent mutations produce explicit conflict and never lose a grant silently.
- Accepted before/after Visibility is normalized and audited once.

## Verification

```bash
bun test packages/authorization
bun run typecheck
```

