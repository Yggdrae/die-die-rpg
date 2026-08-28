# TechSpec: Campaign Lifecycle

Source: `_prd.md`, `_bdd.md`, `_db.md`, feature 01 artifacts, feature 00 contracts/freeze, and
feature 08 `_prd.md`.

## Current Facts

- The repository has Fastify/React shells, frozen `SystemRef`, fixture campaign data, PostgreSQL
  tooling scoped to `packages/identity`, and no campaign package or routes.
- `SystemSummary`, manifest option/game-mode declarations, and a runtime system registry are not
  implemented. Feature 08 owns them; this feature builds against typed fixtures until available.
- Feature 01's current migration has no campaign membership/invitation tables yet. Campaign/owner
  atomicity therefore remains an integration dependency, not existing behavior.

## Proposed Architecture

Add `packages/campaigns` with feature-owned contracts, application services, domain validation, and
PostgreSQL/local repository adapters. Fastify registers a thin campaign plugin; React adds a
feature-scoped wizard and campaign list. Consumers import only the package entry point.

Core interfaces:

- `SystemCatalog`: list/search summaries, resolve exact version, compatible modules, modes/options.
- `CampaignRepository`: create aggregate, get/list, update details, update pin, settings, soft delete.
- `CampaignContextResolver`: authorized local/server context boundary for other features.
- `CampaignOwnerParticipant`: narrow feature 01 transaction participant for initial owner creation.
- `CampaignSettingRegistry`: namespace, TypeBox schema, visibility, and authorization declaration.
- `AuditRecorder` and `SyncedRepository` frozen boundaries.

No domain/application module imports Fastify, React, Drizzle, PostgreSQL, PowerSync, or a system
implementation. P0 module pins are immutable after creation.

## Data Flow

Creation wizard state is in-memory only. The client validates steps from manifest declarations,
then submits one aggregate with a client UUID. Online creation commits campaign, pins, settings,
and owner membership in one PostgreSQL transaction. Offline creation records the same aggregate in
one local transaction; feature 03 uploads it as one causal unit, then queues invitation creation.

System update resolves the exact installed target, presents available change metadata when present,
requires owner confirmation, and performs one expected-version pin update. Removed/changed options
block the update with an explicit incompatibility list; P0 never silently drops or migrates them.

## API

All routes use TypeBox and the shared `ApiError`.

| Method | Path | Authorization | Purpose |
| --- | --- | --- | --- |
| GET | `/systems` | authenticated | summaries/search from feature 08 |
| GET | `/campaigns` | current memberships | list current user's campaigns |
| POST | `/campaigns` | authenticated | atomic campaign creation |
| GET | `/campaigns/:id` | feature 04 read | campaign view/context |
| PATCH | `/campaigns/:id` | owner | name/description only |
| DELETE | `/campaigns/:id` | owner | versioned tombstone |
| GET | `/campaigns/:id/system-update` | owner | available target and review data |
| POST | `/campaigns/:id/system-update` | owner | explicit version update |
| PUT | `/campaigns/:id/settings/:namespace` | registered policy | versioned namespaced value |

System selection/search may later move behind feature 08 routes; the boundary remains `SystemCatalog`.
Non-member/missing reads use `not_found_or_forbidden`. Context resolution excludes tombstones and
fails if the exact pin is unavailable.

## Authorization and Visibility

Feature 01 supplies the Actor; feature 04 decides every campaign operation. P0 owner controls detail
updates, delete, and system update. Players have read-only member context. Namespace declarations
state which roles may write. No request body role is trusted.

Campaign name/description are member-only. No content route exists without a registered decision.
The architecture guard gains a rule rejecting imports of campaign schema internals outside the
package and direct non-owner SQL access.

## Persistence, Offline, Realtime, Blobs

Use `_db.md` unchanged: four PostgreSQL tables, deferred exactly-one-owner trigger, versioned local
replicas, and no hard delete. Expand Drizzle tooling to accept per-feature schema/config without
making identity import campaign internals.

Feature 03 implements local writes, queueing, conflicts, and tombstones. The web UI observes
deferred conflicts. There is no WebSocket path. Cover image is P1 and, when implemented, uses
feature 05; no blob column is added here.

## Failure Handling

- Unknown/unavailable system version, invalid mode/option/module, unregistered setting namespace,
  and stale version return stable business errors.
- Creation is idempotent by client campaign ID and atomic; duplicate retry returns the existing
  owned campaign only when the submitted aggregate matches.
- System update never substitutes a version and never mutates incompatible settings.
- Audit failure follows the non-blocking recorder contract; authoritative state still commits.
- Offline authority rejection becomes a feature 03 deferred conflict/error and does not disappear.

## Testing

- Unit: manifest-driven steps, reset-on-system-change, option validation, pin immutability,
  namespace registry, context mapping.
- PostgreSQL: atomic creation/owner trigger, idempotent retry, concurrent pin update, soft delete,
  settings version conflict.
- Contract: feature 08 catalog fixtures, feature 01 owner participant, context resolver, TypeBox APIs.
- Sync: offline creation/reconnect, tombstone, exact context, queued invitations.
- Playwright: system selection through created campaign under three minutes; abandon/failure leaves
  nothing; update is explicit; unauthorized/missing responses match.
- Guard: no system-ID branch, deep import, or external campaign-table access.

## Impacted Areas

- `packages/campaigns/` — new package, schema, migrations, services, public entry point.
- `apps/api/src/modules/campaigns/` — Fastify composition/routes.
- `apps/web/src/features/campaigns/` — wizard, list, details/update UI.
- `drizzle.config.ts` or per-package configs — multi-feature migration discovery.
- `tools/guard/` — campaign persistence boundary rule.
- Feature 01 integration — invitations/memberships and deferred owner constraint.
- Feature 08 integration — catalog/manifest adapter.

## Decisions and Blockers

- P0 party step queues invitations only and creates no characters.
- P0 module pins cannot change after creation.
- Only owner may update the pinned system version.
- Wizard drafts are not persisted.
- Blocking: feature 08 must publish the catalog/manifest contracts or approve the fixture-compatible
  interface before production implementation.
- Blocking: feature 01 membership schema and owner transaction participant must land with the
  cross-table constraint migration.

