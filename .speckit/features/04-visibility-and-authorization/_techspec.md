# TechSpec: Visibility and Authorization

Source: `_prd.md`, `_bdd.md`, `_domain.md`, `_db.md`, frozen contracts, and features 01/03 artifacts.

## Current Facts

- `Role`, `ActorRef`, `Visibility`, `EntityEnvelope`, and safe API errors exist in `@rpg/contracts`.
- Fastify has a shared error handler but no content routes or authorization plugin.
- The architecture guard checks system IDs and package dependencies; it does not prove a content
  route calls authorization or that API/sync rules agree.
- Feature 01 actor resolution and feature 03 sync enforcement are only partially/not implemented.

## Proposed Architecture

Add `packages/authorization` containing pure policy types and behavior:

- `ResourcePolicyRegistry` validates declarations at composition.
- `AuthorizationService.decide(actor, capability, resourceFacts)` returns allow/deny plus reason.
- `VisibilityService.change(...)` validates targets and performs versioned reveal/un-reveal through
  an owner-supplied adapter.
- `SyncPredicateCompiler` converts the same declaration to a provider-neutral predicate AST.
- `authorizationTestKit` exhaustively compares pure and sync outcomes.

Resource-owning packages depend on the public authorization entry point and register adapters from
application composition. Authorization never imports their internals. Fastify pre-handlers resolve
the authoritative Actor and invoke the service, while application services repeat the decision at
the mutation boundary so a missed route hook cannot authorize a write.

## Contracts

Feature-local public types:

- `Capability = read | create | update | delete | reveal | manage_members | export` plus registered
  resource-specific verbs.
- `Decision = {allowed:true, reason} | {allowed:false, reason}`.
- `ResourceFacts`: campaign ID, class/id, Visibility, version, optional owner/author/party facts.
- `ResourcePolicy`: defaults, role-capability matrix, ownership predicate, adapter, sync predicate.
- `VisibilityChange`: reveal/un-reveal target with expected version.

Global frozen contracts do not change. Author-private notes use `ResourceFacts.authorUserId` and a
policy override. Party predicates remain disabled until a resolver registers.

## API

| Method | Path | Purpose |
| --- | --- |
| PATCH | `/campaigns/:campaignId/resources/:class/:resourceId/visibility` | versioned reveal/un-reveal through registered adapter |

Request contains operation, target mode/IDs, and expected version. Actor/role never appear in the
body. Success returns normalized Visibility/version. Unknown class, hidden record, and denial map to
the same safe public response where existence matters. Content owner routes use typed pre-handler
helpers rather than a second authorization vocabulary.

## Decision and Sync Flow

Startup validates every declaration and compiles its predicate. A registration failure prevents
the affected application from starting. CI runs the full role/mode/campaign/ownership matrix through
both the pure evaluator and provider adapter; any divergence fails.

Read/list routes authorize before serialization and compute totals from the permitted set. Sync
predicates filter before rows leave PostgreSQL. Visibility narrowing removes rows locally; feature
05 consumes the same removal to erase bytes. Tombstones for never-visible rows are excluded.

## Persistence and Offline

Use `_db.md`: no central P0 table, standard columns on owner records, code registry, versioned
adapter writes, and target normalization. Offline decisions use cached Actor/resource facts and are
identical to server logic. Offline visibility changes may record locally for authorized GM roles but
the authority rechecks role/targets; rejection becomes a deferred conflict/error.

There is no realtime service or blob storage. Attachment signed URL decisions delegate here.

## Security and Failure Handling

- Unknown/missing input, observer, cross-campaign actor, unresolved party, and missing declaration
  deny without fallback.
- Public denial reasons are collapsed; internal metrics use stable non-sensitive reason codes.
- Resource adapters receive only authorized operation context and cannot return raw table handles.
- Audit records only accepted visibility mutations. Denial metrics are aggregated by class/reason,
  never actor ID.
- The guard adds AST/import conventions for campaign-content routes plus a registry conformance
  inventory. Runtime tests remain the primary proof because static analysis cannot prove all paths.

## Testing

- Unit: exhaustive role/capability/visibility matrix, author-private override, target normalization,
  fail-closed cases, cross-campaign denial.
- Contract: each registered owner adapter and sync predicate through shared test kit.
- Integration: direct API bypass attempts, indistinguishable miss/denial, counts/pagination,
  concurrent reveal, audit emission.
- Sync: no hidden row/tombstone/private note on unauthorized replicas; reveal/un-reveal delivery.
- Attachment/export: no signed URL without decision; visibility round trip does not widen.
- Guard negative fixtures: content route with no helper, local role literal, direct membership store.

## Impacted Areas

- `packages/authorization/` — new public module, registry, evaluator, test kit.
- `apps/api/src/modules/authorization/` — composition and visibility route.
- `apps/web/src/features/visibility/` — generic reveal/un-reveal controls and target picker.
- `packages/sync/` — predicate adapter only, owned by feature 03.
- `tools/guard/` — enforce sanctioned authorization imports/route inventory.
- Every content owner — one public Resource Policy registration, no internal import.

## Decisions and Blockers

- Un-reveal is P0.
- Party targeting remains unavailable/fail-closed until a party resolver exists.
- Author-private notes require no frozen contract change.
- Resource owners must publish their exact capability matrix before their content routes can start;
  undeclared combinations are implementation blockers for those features, not permissive defaults.

