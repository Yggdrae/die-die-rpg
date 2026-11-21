# Task 02: Identity Package Contracts and Domain Rules

## Goal

Create the infrastructure-free identity module surface and pure rules used by all later tasks.

## Dependencies

- Task 01

## Scope

### Change

- Scaffold `packages/identity` with strict TypeScript, package exports, and repository-standard
  scripts.
- Define TypeBox boundary schemas for account, session, recovery, invitation, membership, and
  pagination payloads without serializing stored secrets.
- Publish `AuthenticatedUser`, `ActorResolver`, and the narrow transactional
  `CampaignMembershipWriter`; keep repository contracts internal.
- Implement pure username normalization, MVP-role validation, invitation-role validation,
  removal/role-change/ownership rules, and token lifecycle evaluation.
- Add focused unit and schema tests, including reserved `observer` rejection.

### Do Not Change

- No Fastify, PostgreSQL, cookies, hashing library, routes, or feature-internal imports.
- Do not duplicate `Role`, `ActorRef`, `Id`, `Result`, or `ApiError` from `@rpg/contracts`.

## Acceptance Criteria

- [x] Domain code has no infrastructure imports.
- [x] Exactly the four MVP membership roles can be read; ordinary writes cannot assign `owner` or
  `observer`.
- [x] Removal and ownership decisions match the approved BDD.
- [x] Secret-bearing input schemas have no corresponding response fields.
- [x] Public interfaces are sufficient for feature 02 without exposing membership storage.

## Verification

```bash
bun run --filter @rpg/identity typecheck
bun test packages/identity
bun run check packages/identity
```
