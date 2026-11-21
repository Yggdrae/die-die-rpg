# Task 04: Fastify enforcement and safe denial behavior

Status: completed (2026-10-25). Depends on tasks 01–03 and feature 01 resolver.

## Scope

- Add authorization composition/helpers and generic visibility-change route with TypeBox.
- Resolve Actor server-side and enforce again at application mutation boundary.
- Filter lists/counts before serialization and collapse hidden/missing responses.
- Test direct requests, client role spoofing, attachment-owner delegation, and pagination.

## Acceptance Criteria

- [x] No client-supplied role affects a Decision.
- [x] Hidden records leak no metadata, count, status, or identifier difference.
- [x] Every registered content route uses the sanctioned decision helper.

## Verification

```bash
bun test apps/api/src/modules/authorization packages/authorization
bun run typecheck
```

## Evidence (2026-10-25)

- `bun test apps/api/src/modules/authorization packages/authorization` (with `.env`): 109 pass,
  0 fail, 585 expects, 7 files (29 in `apps/api/src/modules/authorization`, 80 in the package).
- `bun test apps/api --timeout 30000`: 126 pass, 0 fail. `bun run typecheck`: 10/10 workspaces exit 0.
  `bun run check`: 222 files clean. `bun run guard`: 186 files, no violations.

## Implementation

- `apps/api/src/modules/authorization/content-access.ts`: `ContentAccess`, the sanctioned decision
  helper. `requireResource` and `requireCollection` mint pre-handlers that resolve the Actor from
  the authenticated session (`ActorResolver`), decide through `AuthorizationService`, and answer
  every denial with the byte-identical `not_found_or_forbidden` 404. `request.contentAccess` offers
  `decide`, `filter`, `page` (filter first, totals from the permitted set).
  `authorizeResource` is the non-request entry point (attachment owners, services).
- `inventory.ts`: runtime route inventory. A route under `/campaigns/:campaignId/resources/` or with
  `config.contentRoute` must carry a pre-handler minted by `ContentAccess` (module-private
  WeakMap), otherwise `ready()` throws `UnsanctionedContentRouteError`. A collection route that
  sends 2xx without consulting the filter is turned into a 500 in `preSerialization`.
- `visibility-routes.ts`: `PATCH /campaigns/:campaignId/resources/:class/:resourceId/visibility`
  (TypeBox, `additionalProperties: false`, no actor/role/campaign in body). `runtime.ts` composes
  `ContentAccess` and `VisibilityService` (registry now `requireVisibilityAdapters: true`).
- Tests use an invented fixture class and in-memory adapter (`test-fixture.ts`); the adapter passes
  `runVisibilityAdapterContract`. No production content class was added.

## Gaps

- No production content class or adapter exists, so the runtime route denies every class (proved by
  `runtime.integration.test.ts`). The first content owner registers a policy plus adapter and uses
  `requireResource` / `requireCollection`.
- Static guard rule for the sanctioned helper is task 07; this task provides the runtime inventory only.
- `party_unresolved` is unreachable over HTTP in P0: a class cannot declare party reveal targets
  while party targeting is inactive, so the route answers `target_mode_not_allowed`.
- Offline (feature 03) visibility mutations still bypass this route; authority recheck remains open.
