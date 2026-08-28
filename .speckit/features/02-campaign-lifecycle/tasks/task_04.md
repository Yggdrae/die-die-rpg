# Task 04: Fastify campaign API

Status: pending. Depends on task 03 and feature 04 decision API.

## Scope

- Register campaign routes from `_techspec.md` with TypeBox schemas.
- Resolve Actor server-side and call feature 04 for every read/write.
- Map hidden/missing targets and business/version failures to stable `ApiError` responses.
- Add route integration tests including direct bypass attempts.

## Acceptance Criteria

- No route trusts a role or campaign context supplied by the client.
- Non-member and missing campaign responses are indistinguishable.
- Owner-only mutation rules and namespace policies are enforced in application service and route tests.

## Verification

```bash
bun test apps/api/src/modules/campaigns packages/campaigns
bun run typecheck
```

