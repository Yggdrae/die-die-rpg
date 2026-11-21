# Task 03: Authorized audit query API

Status: completed (2026-10-26). Membership events are readable by the GM roles only (follow-up
2026-10-26, see "Membership events"); the reader rule is Approved (2026-10-28, delegated by owner).

## Scope

- Implement campaign/session query services, sequence cursors, actor/target filters, and rendering.
- Apply current target visibility before rows, totals, pagination, and renderer values.
- Add Fastify routes with TypeBox and separate private-route authorization.
- Test hidden/missing targets, author-private targets, and safe renderer fallback.

## Acceptance Criteria

- [x] Players receive only events whose targets they currently may see.
- [x] Campaign/private stores cannot be unioned through public API.
- [x] Raw before/after JSON is never a fallback response.

## Verification

```bash
bun test packages/audit apps/api/src/modules/audit
bun run typecheck
```

## Progress

- `packages/audit/src/query.ts`: `AuditQueryService`, bound to one store reader at composition.
  - Ports: `AuditEventReader` (store side) and `AuditReadAuthorizer` (caller side, fail closed).
  - The service reads the distinct (target, stored snapshot) groups in scope and asks the
    authorizer once per group. Only then does it count and page, so rows, totals, cursors and
    renderer input come from the permitted groups only.
  - Output (`AuditEntryView`): id, session, actor, action, target, `acceptedAt`, and the rendered
    `description`. It never carries before/after values or the raw campaign sequence, because
    sequence gaps would disclose hidden events.
  - Rendering goes through `AuditRendererRegistry.render`, which falls back to a generic text.
- `CampaignAuditRepository` and `PrivateAuditRepository` (`infra/postgres/repositories.ts`)
  implement the reader on their own table: `targetGroups`, `countWithin`, `pageWithin`.
  - Permitted groups are passed as one `jsonb_to_recordset` parameter and the snapshot is compared
    as jsonb.
  - Ordering is by authority `campaign_sequence`, newest first.
  - The cursor is the last returned event ID. It resolves to its sequence only among permitted rows
    in the same scope and store. A hidden, private, foreign or unknown ID is the same
    `invalid_cursor`.
- `createPostgresAuditRuntime` now also returns
  `queries: { campaign, private }`, one service per physical store.
- `apps/api/src/modules/audit/target-access.ts`: `AuditTargetAccess.readerFor(actor, store)`
  decides `read` through `AuthorizationService.decide`, on facts loaded from the registered source
  (Visibility adapter or extra `ResourceFactsSource`). An event is readable only if all of these
  allow:
  1. the target's current facts (current Visibility and the class's Ownership Rule);
  2. the stored snapshot applied to the same record, which can narrow but never widen;
  3. for the GM-private store, the current facts narrowed to `gm_only`.

  An undeclared class, a missing or foreign record, a source with no answer, or a malformed
  snapshot hides the event. Author-private rules come from the class declaration, so a `gm_only`
  snapshot never lets a GM role read another author's private target.
- `apps/api/src/modules/audit/routes.ts` (TypeBox, `config.contentRoute: true`, sanctioned
  `ContentAccess.requireResource` on the `campaign` record with `read`):
  - `GET /campaigns/:campaignId/audit`
  - `GET /campaigns/:campaignId/sessions/:sessionId/audit`
  - `GET /campaigns/:campaignId/audit/private`: also requires
    `request.contentAccess.decide({ ...campaignFacts, visibility: gm_only })`, so only GM roles
    (as feature 04 decides) reach the private store; everyone else gets the safe 404.

  Query: `cursor`, `limit` (1..100, default 50), `actorId`, `targetType`, `targetId`; the private
  route also accepts `sessionId`. `additionalProperties: false` everywhere, so `store`, `private`
  or `role` inputs are a 400.

  Replies: 200 `{ items, total, nextCursor? }`, 400 `invalid_cursor`, 401, and the safe 404 for
  observers, non-members, other-campaign members and deleted campaigns.
- `apps/api/src/runtime.ts`: the campaign facts source is shared by `ContentAccess` and
  `AuditTargetAccess`, and `registerAuditRoutes` is wired with `durableAudit.queries`.
- No migration. The task 01 indexes cover campaign, session, actor and target scopes.

## Membership events (follow-up, 2026-10-26)

Feature 01 and 06 specs require membership and role changes to be recorded ("an access question
has an answer") but name no reader. Rule chosen, the narrowest defensible one:

- Class `campaign_membership` (`CAMPAIGN_MEMBERSHIP_RESOURCE_POLICY` in
  `apps/api/src/modules/sync/sync-rules.ts`): `read` for owner, gm and assistant_gm; player and
  observer have no capability; default visibility `gm_only`; `sync: server_only`. Membership
  events therefore never replicate (the PowerSync YAML is unchanged, drift test green) and their
  recorded snapshot is `gm_only`.
- Only GM roles read the history of any member, including the player's own membership events: a
  player already learns its own role from its membership row.
- GM-only readership: Approved (2026-10-28, delegated by owner). Widening later (for example a
  player reading events about their own membership) is a policy-only change.
- Facts source: `apps/api/src/modules/audit/membership-facts.ts`. The resource ID is the member's
  user ID. It reads through the new identity public API `MembershipService.historyFact(campaignId,
  userId)` (existence and version only; no role, no username). A removed membership still
  resolves, so its history stays readable; a user who never belonged to the campaign has no
  facts and the event stays hidden.
- The source is passed only to `AuditTargetAccess`, not to `ContentAccess`, so no content or hold
  route can address the class.
- Tests: `membership-facts.test.ts` (5: registration and conformance, role matrix over current and
  removed members, non-member and foreign facts, snapshot cannot widen, facts shape),
  `membership-service.test.ts` (1: `historyFact`), the runtime composition test in
  `routes.integration.test.ts` (owner and assistant_gm see all 6 events, including the removed
  member's created and removed events; a player sees only `campaign.created`; removed member and
  stranger get the safe 404), and the production-policy matrix in `security-acceptance.test.ts`
  (server-only classes assert that no replica row is synced).

## Evidence (with `.env`, 2026-10-26)

- `bun test packages/audit apps/api/src/modules/audit --timeout 30000`: 80 pass, 0 fail, 9 files.
  New tests:
  - `packages/audit/src/query.test.ts`: 8;
  - `packages/audit/src/infra/postgres/query.integration.test.ts`: 5;
  - `apps/api/src/modules/audit/target-access.test.ts`: 4;
  - `apps/api/src/modules/audit/routes.integration.test.ts`: 11, one of them through
    `buildRuntimeApp`.
- `bun test apps/api --timeout 30000`: 198 pass, 0 fail, 26 files.
- `bun run check`: clean. `bun run guard`: 218 files, no violations.
- `bun run typecheck`: `@rpg/audit` and `@rpg/api` pass. The only failure is in
  `packages/campaigns/src/application.test.ts` (two TS2769 errors), which another agent is
  editing.
- Mutation checks:
  - dropping the current-facts decision fails 5 tests;
  - dropping the snapshot decision fails 2;
  - dropping the private gate fails 2;
  - dropping the per-row private narrowing fails 1;
  - dropping the permitted-group filter from `countWithin` fails 8.

## Gaps

- Any undeclared class stays hidden from every role. Membership events are now declared (see
  "Membership events"); their GM-only reader rule is Approved (2026-10-28, delegated by owner).
- A deleted record's history is hidden, because its source returns no facts for a tombstone.
  Owners that want history readable after delete must return tombstone facts.
- No sessions feature exists yet (feature 18), so the session route does not check that the
  session exists. An unknown session ID returns an empty page.
- Cost per request: one distinct-groups scan, one facts load per distinct target, then a count and
  a page. No caching.
- If a target changes visibility between pages, the next page and its total follow the new
  decision, and an anchor that became hidden returns `invalid_cursor`.
- Offline/local reads, the merge of pending and accepted events, and sync filtering are task 04.
  The UI is task 05.
