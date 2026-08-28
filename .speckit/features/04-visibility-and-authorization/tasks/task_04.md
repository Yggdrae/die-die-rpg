# Task 04: Fastify enforcement and safe denial behavior

Status: pending. Depends on tasks 01–03 and feature 01 resolver.

## Scope

- Add authorization composition/helpers and generic visibility-change route with TypeBox.
- Resolve Actor server-side and enforce again at application mutation boundary.
- Filter lists/counts before serialization and collapse hidden/missing responses.
- Test direct requests, client role spoofing, attachment-owner delegation, and pagination.

## Acceptance Criteria

- No client-supplied role affects a Decision.
- Hidden records leak no metadata, count, status, or identifier difference.
- Every registered content route uses the sanctioned decision helper.

## Verification

```bash
bun test apps/api/src/modules/authorization packages/authorization
bun run typecheck
```

