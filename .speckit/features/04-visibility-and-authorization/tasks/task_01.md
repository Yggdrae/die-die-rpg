# Task 01: Pure decision engine and matrix test kit

Status: completed.

## Scope

- Create `packages/authorization` public decision/capability/resource-facts types.
- Implement fail-closed campaign/role/capability/Visibility evaluation.
- Add exhaustive matrix helpers and stable internal/public denial mapping.
- Test observer, unknown, missing, targeted, GM-only, everyone, and cross-campaign cases.

## Acceptance Criteria

- Same declared inputs always produce the same outcome without request/infrastructure state.
- Unknown and observer inputs deny.
- Public hidden/missing outcomes are indistinguishable.

## Verification

```bash
bun test packages/authorization
bun run typecheck
```
