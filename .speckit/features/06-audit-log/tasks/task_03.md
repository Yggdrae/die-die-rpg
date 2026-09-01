# Task 03: Authorized audit query API

Status: pending. Depends on tasks 01–02 and feature 04.

## Scope

- Implement campaign/session query services, sequence cursors, actor/target filters, and rendering.
- Apply current target visibility before rows, totals, pagination, and renderer values.
- Add Fastify routes with TypeBox and separate private-route authorization.
- Test hidden/missing targets, author-private targets, and safe renderer fallback.

## Acceptance Criteria

- Players receive only events whose targets they currently may see.
- Campaign/private stores cannot be unioned through public API.
- Raw before/after JSON is never a fallback response.

## Verification

```bash
bun test packages/audit apps/api/src/modules/audit
bun run typecheck
```

