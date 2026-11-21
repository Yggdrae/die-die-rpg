# Task 08: Campaign boundary guard and acceptance flows

Status: pending. Guard rules, UI acceptance flows, and runtime/PostgreSQL acceptance are done and green. Remaining: the real-stack offline end-to-end convergence scenarios (see "Blocked") depend on feature 03 task 04 (creation-scoped upload authorization and per-mutation acceptance signal) and on server-to-replica tombstone/revocation delivery (task 06 blockers). Mark completed when those scenarios can be automated against the real authority.

## Scope

- Extend guard rules/negative fixtures for external campaign schema access and system-ID branches.
- Add end-to-end creation, authorization, pin/update, offline, and deletion acceptance flows.
- Verify audit/context/owner integration through public boundaries.
- Update only repository operational docs required by actual commands/configuration.

## Acceptance Criteria

- Guard fails on direct/deep campaign persistence access outside the package.
- BDD P0 scenarios have automated coverage or an explicit manual performance gate.
- Full repository gates pass with no P1 behavior enabled accidentally.

## Delivered

Guard (`tools/guard/src/rules.ts`, negative fixtures in `rules.test.ts`):

- `no-campaign-persistence-imports`: rejects `from`/`import()`/`require` of `@rpg/campaigns/**/infra/**`, `**/schema`, or a relative path into `campaigns/src/infra|schema` outside `packages/campaigns/`. Integration tests elsewhere may still use raw SQL (`no-external-campaign-store-access` precedent) but may not import persistence modules.
- `no-system-id-branch`: rejects comparing/switching/looking up/`includes` on `systemId`/`system.id` against literals, for any id (complements the known-id list in `no-system-identity`). Exempt: `systems/`, `packages/fixtures/`, test files.

Acceptance automation:

- `apps/api/src/campaign-lifecycle.integration.test.ts`: real `buildRuntimeApp` over HTTP + PostgreSQL. Covers invalid creation persists nothing, idempotent retry, exactly one owner, member-only list/read, non-member vs missing identical `not_found_or_forbidden`, player denied edit/update/delete, newer version offered not applied, details edit leaves pin, concurrent update (one 200, one 409), unowned namespace rejected, membership loss removes list/read, soft delete tombstone retained. `buildRuntimeApp` gained an optional `systems` input (default unchanged) to install two versions.
- `apps/web/e2e/campaign-lifecycle.e2e.ts` (`bun run test:e2e`): wizard (declared modes only, skipped steps, five integration statuses, rules link, search, empty name blocked, failed creation then retry, no role claims), abandon keeps no draft, player/non-member UI, explicit pin update with keep-current and conflict, delete failure then success. API mocked at the network edge (repository convention).
- `packages/campaigns/src/context.test.ts`, audit test in `application.test.ts`.
- Fixes found by this task: `CampaignService.list` returned tombstoned campaigns on PostgreSQL; `CampaignDashboard` showed only two of five integration statuses and no rules entry point.

## BDD P0 traceability

| Scenario group / scenario | Coverage |
| --- | --- |
| Selection renders from summary alone; unknown system unchanged | e2e wizard (fixture system is neither MVP system); guard `no-system-id-branch`/`no-system-identity` |
| Text search narrows / clearing restores | `context.test.ts` (catalog), e2e wizard search |
| All integration statuses shown; mechanics not documentation rights; rules reachable before creation | e2e wizard (five statuses, rules link, no POST) |
| Game modes only declared; steps skipped when empty | `domain.test.ts`, e2e wizard |
| Options render from declarations / constraints block | `domain.test.ts` (validation). UI rendering with a declaring system not e2e-covered: the only installed manifest (fixture) declares no options or modules. Gap until a fixture system declares them |
| Module choices limited to compatibility; records exactly the choices | `domain.test.ts`, `application.test.ts`, `repository.integration.test.ts` |
| Changing system clears dependent choices | `domain.test.ts`, `wizard-state.test.ts` |
| Details collect name+description; empty name rejected | e2e wizard, runtime integration (400, nothing persisted) |
| Abandon persists nothing; failure persists nothing | e2e abandon + failure/retry, runtime integration, `repository.integration.test.ts` (rollback) |
| Pin resolved at creation; exactly the choices recorded | runtime integration, `application.test.ts` |
| Campaign and owner commit together, concurrent | `repository.integration.test.ts` (atomic, concurrent, deferred trigger), runtime integration (one owner = creator) |
| Creation emits audit event | `application.test.ts` (recorder contract); durable store: `audit-runtime.integration.test.ts` "membership, campaign, and recovery events are durably recorded" (`campaign.created` in `audit_campaign_events` through `POST /campaigns`) |
| Creation fits 3-minute budget | Manual performance gate: with an installed system and an existing account, time the wizard from system selection to the created campaign (target under 3 minutes, stopwatch, 3 runs). Not automated; mocked e2e proves nothing about GM time |
| Newer version does not move pin; consumers resolve pinned | runtime integration, `context.test.ts` |
| Nothing but update flow writes the pin | runtime integration (edit, join, setting write); `updatePin` is the sole pin writer (`repository.ts`); guard blocks external table access. Restart/sync: structural only |
| Unresolvable pin fails closed | `context.test.ts` |
| Newer offered never applied; keep current; explicit update recorded; no automatic path | runtime integration, e2e pin flow, `application.test.ts` audit (previous/new version recorded, no event without a call) |
| Concurrent updates: exactly one applies | `application.test.ts`, runtime integration (200 + 409). Gap: HTTP 409 carries `version_conflict` only, not expected/actual versions (those exist on the sync deferred-conflict path) |
| Listed only for current members; losing membership removes it | runtime integration |
| Non-member read indistinguishable | runtime integration, `routes.test.ts` |
| Editing leaves pin/modules; player changes nothing | runtime integration, e2e player view, `application.test.ts` |
| Deletion is a tombstone; deleted resolves no context | runtime integration (row retained, list/read 404), `application.test.ts` (resolve undefined). Deletion audit: `application.test.ts`; durable `campaign.deleted` and `campaign.details_updated` rows via public `PATCH`/`DELETE` in `audit-runtime.integration.test.ts` |
| Context full shape; requires access | `context.test.ts`, runtime integration |
| No other feature imports internals | guard `no-campaign-persistence-imports` + `no-deep-package-imports`, `rules.test.ts` negative fixtures |
| Settings: namespace isolation, schema rejection, unowned rejected, audited | `application.test.ts`, `domain.test.ts`, runtime integration (unowned). Setting audit: `application.ts` records `campaign.setting_changed` through the same recorder that `audit-runtime.integration.test.ts` proves reaches the durable store; synced setting mutations are audited once under their mutation ID ("synced mutations are audited once under their mutation ID") |
| Party step creates invitations only, no characters | e2e wizard (request keys carry no character data); no character code exists in this feature |

## Offline and audit scenarios (previously blocked, now automated)

| Scenario | Coverage |
| --- | --- |
| Offline creation readable locally, converges after reconnect with same IDs and pin | `offline-campaign.integration.test.ts` "creation is readable at once, converges with identical IDs and pins, and survives restart and replay" (real HTTP `POST /sync/mutations`, creation-scoped auth, PostgreSQL); unit: `campaign-applier.test.ts` "survives restart and converges with identical IDs and pins exactly once"; `offline.test.ts` |
| Rejected creation leaves no partial aggregate | `offline-campaign.integration.test.ts` "rejected creation leaves no partial aggregate at the authority and queues nothing"; `campaign-applier.test.ts` "rejected or denied creation queues no invitation and leaves no authority aggregate" |
| Invitations queued offline, not reported delivered, created after reconnect | `campaign-applier.test.ts` "invitations queue only after authority acceptance, never offline, once per intent", "restart after acceptance but before dispatch still releases invitations exactly once"; real endpoint 404 before upload and 201 after in `offline-campaign.integration.test.ts` (first test); `offline.test.ts` "campaign replica sync dispatch" |
| Context resolves offline and matches last sync | `offline.test.ts`, `campaign-applier.test.ts`; reconciler cache: `apps/api/src/modules/sync/membership-reconciler.test.ts` |
| Stale offline edit is a deferred conflict | `offline-campaign.integration.test.ts` "stale offline edit becomes a deferred conflict; the authority value stands" |
| Deletion/revocation removes local context | `offline-campaign.integration.test.ts` "membership revocation removes local context and the authority refuses the stale edit", "campaign deletion removes local context whether made on the device or elsewhere" |
| Durable `AuditEvent` for create/update/delete/setting | `audit-runtime.integration.test.ts` (campaign.created, campaign.details_updated, campaign.deleted via public routes; synced mutations once per mutation ID) |

Residual, outside this task: rows reaching a device through a running PowerSync service are tracked by feature 03 task 04 (see task 06 Open).

## Verification

```bash
bun run check
bun run typecheck
bun test
bun run guard
bun run build
bun run test:e2e
```

Integration tests need `DATABASE_URL` (or `TEST_DATABASE_URL`) and a migrated database (`bun run db:migrate`); they skip when unreachable.
