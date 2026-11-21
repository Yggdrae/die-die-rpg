# TechSpec: Campaign Content and Entities

Status: approved 2026-10-28 (decisions D-01..D-18 and blocker plans B-1..B-5 delegated by the
owner; see "Decisions" and "Cross-Feature Blocker Resolutions").

Source: `_prd.md`, `_bdd.md`, `_db.md`, frozen contracts in `packages/contracts`, feature 03/04/05/06/07
specs, and the current code listed under "Current Facts". `_domain.md` is not written: the feature
index marks Domain as not recommended for feature 16, and the few invariants (type as
configuration, relationship visibility bound, author-private notes, broken links) are stated here
and in `_db.md`.

## Executive Summary

Add one generic content module, `packages/content` (`@rpg/content`), that stores every MVP entity
type in one table, personal notes in a second, and typed relationships in a third. Types and
relationship kinds are code configuration. Feature 04 is the only authorization path: the module
registers three Resource Policies (`campaign_entity`, `personal_note`, `entity_relationship`), a
`VisibilityAdapter` for the two reveal-capable classes, and sync bindings compiled into
`infra/powersync/sync-config.yaml`. Writes reach PostgreSQL only through feature 03 mutation
appliers, which re-decide, enforce versions and long-text holds, and record feature 06 audit inside
the domain transaction. HTTP routes are read-only. The web feature mounts feature 04
`VisibilityControls`, the feature 03 conflict surface and hold client, and the feature 05
attachment list on entity detail.

## Current Facts

- Frozen contracts: `EntityEnvelope` + `entitySchema()` (`packages/contracts/src/entity.ts`),
  `Visibility` union and `GM_ONLY` (whose doc comment already cites feature 16 FR-010),
  `ActorRef`/`GM_ROLES`, `Tag` (1..64), `Metadata`, `SyncedRepository`/`ConflictChannel`,
  `ExportableModule`, `SearchIndexer`/`SearchDoc`, `SessionQuickAction`
  (`invoke(context: { actor, sessionId }): Promise<void>`, no input), `AttachmentRef`,
  `AuditEvent`/`AuditRecorder`.
- Feature 04 (`packages/authorization`, completed): `ResourcePolicyRegistry` with startup validation
  (`requireVisibilityAdapters: true` in `apps/api/src/runtime.ts`), `AuthorizationService.decide`,
  `OwnershipRule` (author-private when `exemptRoles` is empty), `VisibilityAdapter` +
  `runVisibilityAdapterContract` (10 checks), `runPolicyConformance`, `checkAuthorPrivate`,
  `syncTruthTable`/`findSyncDivergences`, `VisibilityService` with audited reveal/un-reveal.
  `VisibilityWriteResult` is `{ ok: true, facts } | { ok: false, reason: 'not_found' |
  'version_conflict' }` (`registry.ts`); `VisibilityService` already has the rejection
  `incompatible_visibility`, mapped by `visibility-routes.ts` to 400 `validation_failed`.
- `apps/api/src/modules/authorization`: `ContentAccess.requireResource/requireCollection/
  authorizeResource`, `request.contentAccess.page/filter`, route inventory that fails startup for an
  unguarded content route, safe 404 `not_found_or_forbidden`, generic
  `PATCH /campaigns/:campaignId/resources/:class/:resourceId/visibility`. Guard rule
  `no-local-role-checks` forbids role literals outside `packages/identity`, `packages/authorization`
  and two reasoned web exceptions (`LOCAL_ROLE_CHECK_ALLOWED`).
- `apps/web/src/features/visibility/VisibilityControls.tsx`: generic reveal/un-reveal container,
  props `campaignId, resourceClass, resourceId, visibility, version, viewerRole, onChanged,
  onReload`. Not mounted anywhere yet: the first content owner must mount it.
- Sync (`packages/sync`, `apps/api/src/modules/sync`): `MutationApplier {featureId, tableName,
  apply(context)}` with `AuthorityMutationContext {actor, mutation, recordAudit?}` (no session);
  `AuthorityMutationService.apply(userId, batch)`; the sync routes already know `user.sessionId`
  (hold routes pass it as `holderSessionId`). `REGISTERED_RESOURCE_POLICIES` and
  `SYNC_RULE_BINDINGS` in `apps/api/src/modules/sync/sync-rules.ts`; `compileProviderQueries`
  (PowerSync 1.25.0 dialect: unaliased sources, JSON-array value sets); drift gate
  `sync-config.integration.test.ts`; publication `powersync` lists streamed tables only;
  `LongTextHoldService.mayWriteWithin(transaction, { field, holderSessionId, expectedVersion })` is
  called by the content appliers inside the write transaction; the holds query admits only `resource_class = 'campaign'`; hold routes authorize
  `update` on the named record through `ContentAccess.authorizeResource`.
- PowerSync 1.25.0 resolves each joined relation as its own parameter lookup: an equality between a
  joined row and the streamed row is silently not enforced, and unkeyed joins fail with
  `PSYNC_S2305` (feature 05 task 05, feature 06 task 04). Every feature 16 stream filter must be a
  per-row predicate on the streamed table plus the requester's own membership row; no join to
  another content table.
- Feature 03 task 08 (partial): browser delivery through the PowerSync web SDK is verified; the
  browser replica `Schema` is passed through the `schema` option of `packages/sync/src/browser.ts`.
- Audit (`packages/audit`): `recordWithin(executor, submission)` for in-transaction events,
  `AuditRendererRegistry.register({action, version, payload?, targetVisibility?, render})`,
  query API that hides events of undeclared classes and of records whose facts source returns
  nothing (tombstones included). CI conformance (`apps/api/src/modules/audit/contributors.ts`,
  `contributors.test.ts`): `AUDIT_CONTRIBUTORS` row `16` is `not_built` with prefix `entity`; a
  built row's actions must all start with `entity.`; production source that records an
  `entity.<word>` literal without a registered declaration fails CI; `createAuditRendererRegistry()`
  composes every package's declarations. Audit sync replicates only campaign-scoped classes;
  per-record classes (all three feature 16 classes) stay online-only (`campaign_scope_unprovable`).
- Attachments (feature 05, completed): owner classes are opted in through
  `buildRuntimeApp({ attachments: { ownerClasses } })` (default `[]`; `apps/api/src/main.ts`
  passes none today). Effective decision = owner decision AND the owner declaration evaluated with
  the attachment's own Visibility. Attachment metadata is not replicated (no PowerSync stream);
  devices learn it from the authorized offline set. `AttachmentManifestExporter` exports every
  ready attachment in the campaign regardless of owner class. Web: `AttachmentList({ campaignId,
  owner })` in `apps/web/src/features/attachments/Attachments.tsx`, `uploadAttachment` in
  `attachments-api.ts`.
- Export (feature 07 tasks 02–05): `ExportRegistry` in `@rpg/campaign-portability`; contributors
  are registered in `apps/api/src/modules/portability/composition.ts`
  (`createExportRegistry`) with a placement from `CHUNK_PLACEMENTS` (`entities` →
  `entities/<module>.json`) and `countRecords`. Online export proves consistency by a double read
  with equal canonical checksums, so `export()` must be deterministic. A feature 06 acceptance test
  scans exporters for the word "audit". Import is blocked on the dated contract-change note
  `../00-platform-foundation/2026-10-27-transaction-aware-import-contract-change.md` (proposal,
  awaiting ratification); a contributor implementing only the frozen `import` is preserved
  opaquely and reported `contributor_not_transactional`.
- Fixtures: `FIXTURE_ENTITIES` (5 locations, 6 NPCs, 5 items, mixed visibility) and `ACTORS` in
  `packages/fixtures/src/campaign.ts`.
- Not built: feature 17, 18, 19, 20; feature 07 import (task 06).

## Proposed Architecture

```text
packages/content/                 @rpg/content (new)
  src/types.ts                    type + relationship-kind configuration (data only)
  src/domain.ts                   pure rules: validation, tag normalization, visibility ∩, invariant
  src/schemas.ts                  TypeBox replica/input schemas via entitySchema()
  src/policies.ts                 three ResourcePolicy declarations + sync bindings
  src/application.ts              EntityService, RelationshipService, PersonalNoteService
  src/visibility-adapters.ts      VisibilityAdapter for campaign_entity, entity_relationship
  src/directory.ts                published read API for features 17/18/19 (FR-016)
  src/contributors.ts             ExportableModule + SearchIndexer (FR-015)
  src/audit-declarations.ts       audit event declarations + renderers
  src/offline.ts                  local repositories over SyncedRepository (device)
  src/infra/postgres/schema.ts    Drizzle schema (added to drizzle.config.ts)
  src/infra/postgres/repository.ts
apps/api/src/modules/content/     routes.ts (reads), appliers.ts, composition in runtime.ts
apps/web/src/features/content/    list/filter, detail, quick create, editor, relationships,
                                  session quick actions + quick-create host
```

- `packages/content` depends on `@rpg/contracts`, `@rpg/authorization` (types and the decision
  service), `@rpg/audit` (types for `recordWithin`), `@rpg/sync` (types: `MutationApplier`,
  `LongTextFieldRef`). It does not import identity, campaigns, or other feature internals; campaign
  existence and membership come from the resolved Actor.
- Split into `domain`/`application`/`infra` only at file level; no repository interfaces with one
  implementation beyond the PostgreSQL one plus the device one, which are genuinely two.
- Type configuration (`types.ts`): `{ id, label, pluralLabel, quickCreate: { secondField:
  'summary' }, enabled }`. MVP entries, all enabled: `npc`, `creature`, `location`, `item`,
  `faction`, `note`, `scene` (D-02). No per-type field declarations (D-01). Relationship kinds:
  `{ id, label, inverseLabel }` with the D-08 list; no source/target type restrictions in P0. No
  code path branches on a type ID; the guard gets a rule forbidding type-ID literals outside
  `types.ts` (mirror of `no-system-id-branch`).

## Interfaces and Contracts

No frozen contract changes. Feature-local public types (exported from `@rpg/content`):

- `EntityRecord = Static<typeof EntityReplicaSchema>`: `entitySchema({ summary, description,
  fields })`; `fields` is `Record<string, string>` (D-01).
- `PersonalNoteRecord`: `entitySchema({ authorUserId, body })`, `type` fixed `note`.
- `RelationshipRecord`: `entitySchema({ sourceEntityId, targetEntityId, kind })`; `name` = kind
  label at mapping time, `tags: []`.
- `EntitySummary { id, type, name, summary, visibility, deleted: boolean }` for the directory.
- `EntityDirectory` (server, FR-016): `resolve(actor, campaignId, ids[]) -> Map<id, EntitySummary>`
  (unreadable and missing IDs are both absent), `list(actor, campaignId, filter, page)`. Every call
  decides through `AuthorizationService.decide` per record; no caller-supplied facts.
- Device API (FR-016, for features 18/19): `EntityLocalRepository.quickCreate({ type, name,
  summary? })`, `get`, `list(filter)`, `resolve(ids)` over the local replica (contains only what
  the device may read).
- `QuickCreateInput { type, name, summary? }`: visibility omitted means the policy default.
- Web (D-14): `CONTENT_SESSION_QUICK_ACTIONS: readonly SessionQuickAction[]` (`content.add_npc`,
  `content.add_note`) and `ContentQuickCreateHost`, exported from `apps/web/src/features/content`.

Changes in other packages (Track A, additive, owner-delegated 2026-10-28; none touches
`packages/contracts`): see "Cross-Feature Blocker Resolutions".

## Resource Policies (approved: D-04, D-05, D-06)

| Class | Capabilities | owner / gm / assistant_gm | player | observer | Default | Ownership | Sync |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `campaign_entity` | read, create, update, delete, reveal | all | read | none | `gm_only` | none | `content_entities`, standard columns, `deleted_at` |
| `entity_relationship` | read, create, update, delete, reveal | all | read | none | `gm_only` | none | `content_entity_relationships`, standard columns |
| `personal_note` | read, create, update, delete | none | all | none | `explicit` (`players:[author]`) | `authorUserId` on all four, no exempt role | `content_personal_notes`, `ownershipColumns.authorUserId = author_user_id` |

`revealTargets` defaults to `['players']`; party stays fail-closed. Registration happens by adding
the three policies to `REGISTERED_RESOURCE_POLICIES` and their bindings to `SYNC_RULE_BINDINGS`,
so `runtime.ts`, the drift gate, and the audit target declarations all see the same list.
`campaign_entity` and `entity_relationship` register their adapters; `personal_note` registers a
`ResourceFactsSource` in the runtime `factsSources` list (used by `ContentAccess` and
`AuditTargetAccess`), because it has no `reveal`. A player promoted to a GM role loses access to
their personal notes while promoted (GM roles have none); the rows are retained and readable again
after a return to `player`.

## API

HTTP is read-only; all writes go through `POST /sync/mutations` (one write path, one place that
re-authorizes, holds, versions, and audits). Every route: `config.contentRoute: true`,
`requireAuthenticatedUser`, then a sanctioned helper; lists filter and count through
`request.contentAccess.page` so totals come from the permitted set; misses and denials return the
safe 404.

| Method | Path | Helper | Response |
| --- | --- | --- | --- |
| GET | `/campaigns/:campaignId/entities?type&tag&visibility&q&offset&limit` | `requireCollection(read, campaign_entity)` | `{ items: EntityRecord[], total }` |
| GET | `/campaigns/:campaignId/entities/:resourceId` | `requireResource(read, campaign_entity)` | `EntityRecord` |
| GET | `/campaigns/:campaignId/entities/:resourceId/relationships` | `requireResource(read, campaign_entity)` + per-row `decide` on `entity_relationship` | `{ items: (RelationshipRecord & { other: EntitySummary \| { deleted: true } })[] }` |
| GET | `/campaigns/:campaignId/entity-tags?prefix` | `requireCollection(read, campaign_entity)` | `{ tags: string[] }` from permitted rows only |
| GET | `/campaigns/:campaignId/personal-notes` | `requireCollection(read, personal_note)` | author's notes |
| GET | `/campaigns/:campaignId/personal-notes/:resourceId` | `requireResource(read, personal_note)` | `PersonalNoteRecord` |
| PATCH | `/campaigns/:campaignId/resources/:class/:resourceId/visibility` | existing feature 04 route | unchanged |

`visibility` filter values are accepted only for actors whose decision would admit those rows; a
player filtering by `gm_only` gets an empty permitted set, never an error that confirms existence.

## Mutation Appliers

Three appliers registered in `MutationApplierRegistry` (`featureId = 'content'`, `tableName` =
replica table). Each `apply({ actor, mutation, recordAudit, sessionId })`:

1. validate the payload with TypeBox and the D-11 limits; unknown or disabled type on create,
   unknown kind -> `error` (`invalid_payload`, not retryable);
2. load current facts (create: synthetic facts with the policy default or the supplied Visibility,
   `authorUserId = actor.userId` for notes) and call `AuthorizationService.decide` for the
   operation's capability; deny -> `error` `not_found_or_forbidden`;
3. Visibility on create: only the policy default or an explicit value; an explicit non-default
   value additionally requires the `reveal` decision. Updates never change Visibility (feature 04
   owns changes);
4. long-text change (`description`, `body`): inside the write transaction, before the record row,
   require `LongTextHoldService.mayWriteWithin(transaction, { field, holderSessionId: sessionId,
   expectedVersion: holdVersion })` (B-2, locks the hold row); `sessionId` absent or the check
   false -> `error` `hold_required`;
5. relationships: both endpoints exist in the campaign and are live on create, kind configured,
   not a self-link, not a live duplicate, Visibility within the endpoints' intersection; endpoints
   are locked (`FOR SHARE`) in ascending ID order before the check;
6. PostgreSQL transaction: compare-and-set on `version`, write, then `recordAudit(tx)` once after
   the write matched (feature 06 task 02 pattern); version mismatch -> `conflict` with
   `currentValue` (the authority record serialized for the device);
7. tombstone: sets `deleted_at`, increments version; never touches relationships.

Audit actions, all under the feature 06 contributor prefix `entity` (row `16` of
`AUDIT_CONTRIBUTORS` becomes `built`), registered with payload schemas in
`packages/content/src/audit-declarations.ts` and composed by `createAuditRendererRegistry()`:
`entity.created`, `entity.updated`, `entity.deleted`, `entity.relationship_created`,
`entity.relationship_deleted`, `entity.personal_note_created`, `entity.personal_note_updated`,
`entity.personal_note_deleted`. `before`/`after` carry changed structured fields (name, type,
summary, tags) and, for long text and custom fields, only `{ changed: ['description'] }` /
`{ changed: ['fields'] }`, never the text, field labels, or values. Visibility changes are feature
04's `visibility.revealed/unrevealed`. Personal-note events pass the caller snapshot
`players:[author]`; feature 06 then also applies the class Ownership Rule. No other quoted
`entity.<word>` literal may appear in production source (the feature 06 scan reads it as an
action).

## Authorization and Visibility

- Every read and write decision goes through feature 04 (`ContentAccess` on routes,
  `AuthorizationService.decide` in appliers and the directory). No role literal in feature code
  (guard `no-local-role-checks`). Web affordances (show create/edit/reveal controls, which entry
  points appear) are hints computed from the registered declarations and the cached membership
  role; the authority re-decides every write.
- GM-only default comes from the policy `defaultVisibility`, asserted by test for every type.
- Personal notes: separate class and table. A shared table would leak: the compiled predicate's
  GM-role branch admits `players`-mode rows and the AST has no "column equals constant" node to
  exclude notes. Personal notes take no attachments and no relationships in P0 (D-15).
- Relationship bound (D-07 option A, `_db.md`): enforced on relationship writes (applier, and the
  relationship adapter through the B-1 refusal) and on entity narrowing inside the entity
  adapter's `writeVisibility` transaction: the adapter narrows every live relationship touching
  the entity to the intersection, increments its version, and records one `visibility.unrevealed`
  event each through `recordWithin` on the same executor, attributed to the actor who changed the
  entity.
- Search and export never widen: `SearchDoc.visibility` is the row Visibility; personal notes are
  excluded from the server `SearchIndexer` (D-13) and from export (D-12).

## Data and Persistence

- Source of truth: PostgreSQL tables `content_entities`, `content_personal_notes`,
  `content_entity_relationships`. Details, constraints, limits (D-11), indexes, invariant: `_db.md`.
- Migrations: forward-only via `bun run db:generate` into `packages/identity/drizzle`, plus
  `ALTER PUBLICATION powersync ADD TABLE` and `GRANT SELECT ... TO powersync_replicator` for each
  streamed table (the replication-role test requires grants to match the publication).

## Offline and Synchronization

- Offline behavior: create, structured update, tag, custom fields, link, delete work offline
  through the local repository; the device validates with the same pure `domain.ts` rules
  (including the relationship bound against locally visible endpoints) and queues mutations.
- Long-text editing offline (D-17): text typed without a current hold is a local draft in a
  device-local, unsynchronized store keyed by campaign, class, record, and field; it is never
  queued. After reconnect the editor acquires a hold and the user saves the draft as a normal held
  write. Drafts are cleared by the feature 03 `ReplicaPurgeListener` (revocation, campaign
  deletion, sign-out).
- Sync strategy: compiled feature 04 stream queries for the three tables in a new stream
  `authorized_content` (one query per class, compiled output only, drift-gated). Each query is a
  per-row predicate plus the requester's own membership row (PowerSync 1.25.0 constraint above).
- Conflict strategy: versioned structured edits produce `MutationConflict` rows shown by the
  feature 03 `ConflictSurface` (keep authority / resubmit mine; manual merge not offered in P0).
- Long-text holds: see B-3.
- Attachments: metadata is not replicated (feature 05); entity detail lists attachments online
  through `AttachmentList`, and offline only what feature 05 pinned.

## Realtime

N/A. Changes reach other devices through synchronization.

## Blob Storage

N/A in this feature. FR-009 adds `campaign_entity` to `attachments.ownerClasses` in
`apps/api/src/main.ts` (and the test runtime) and mounts the feature 05 attachment list and upload
on entity detail with `owner = { resourceClass: 'campaign_entity', resourceId }`. Feature 05
authorizes through `ContentAccess.authorizeResource` against this feature's adapter. Upload sends
the entity's current Visibility as the attachment Visibility (an attachment may narrow, never
widen). `personal_note` and `entity_relationship` are not owner classes (D-15).

## Web

- `apps/web/src/features/content/`: entity list with type/tag/visibility filters and name-fragment
  search over the local replica; detail with relationships (both directions, broken links shown as
  deleted); editor for structured fields and free-form custom fields; description editor through
  the feature 03 hold client (`apps/web/src/features/sync/hold-client.ts`) with a plain-text
  Markdown textarea (D-10); conflict surface from `SyncStatus.tsx`.
- Description display (D-10): the stored Markdown source is shown as escaped plain text with line
  breaks preserved. No HTML rendering in P0.
- Mount `VisibilityControls` on entity and relationship detail (`resourceClass` =
  `campaign_entity` / `entity_relationship`, `viewerRole` from the cached membership; server
  decides). Never on personal notes.
- Quick create: one input focused on open (name), optional summary line, Enter saves; type from
  the entry point (Add NPC, Add location, Add note), else `note` (D-09). Target: under 30 s
  including navigation, measured manually mid-session.
- Session Mode entry (D-14): `CONTENT_SESSION_QUICK_ACTIONS` implement the frozen
  `SessionQuickAction`; `invoke({ actor, sessionId })` opens feature 16's own quick-create overlay
  through `ContentQuickCreateHost` (mounted once by the web app shell, not by feature 18) and
  resolves when the overlay closes (saved or cancelled); it never throws on cancel. Feature 18
  lists and invokes the actions without importing feature 16.

## Error Handling

- Unknown type/kind, invalid payload, limit exceeded -> non-retryable `invalid_payload`; the device
  shows the rejected change.
- Denied or missing -> `not_found_or_forbidden` (mutation) / safe 404 (route).
- Stale version -> conflict with both values.
- Missing hold -> `hold_required`; local text kept as draft.
- Relationship bound violation -> `incompatible_visibility` (B-1, reveal) / `invalid_payload`
  (create).
- Audit fault never aborts the domain write (feature 06 recorder semantics).

## Observability

- Logs: mutation ID, campaign ID, class, safe outcome code. Never names, summaries, descriptions,
  tags, field labels or values, or note bodies.
- Metrics: applier outcomes by class/code, relationship narrowing count, quick-create local write
  latency (device). Denials stay in feature 04 `DenialTelemetry` (class + reason only).

## Testing Strategy

- Unit: type configuration validation, tag normalization (D-18), limits (D-11), custom-field rules
  (D-01), visibility intersection and relationship bound (exhaustive over P0 modes), input schemas,
  renderer output, guard rule fixtures.
- Contract: `runVisibilityAdapterContract` (both adapters, `tombstone_excluded` included, plus the
  B-1 refusal check), `runPolicyConformance` for all three classes,
  `checkAuthorPrivate('personal_note')`, `syncTruthTable`/`findSyncDivergences`, feature 06
  `contributors.test.ts`, feature 07 `exportContributorProblems`.
- PostgreSQL integration: CHECKs, appliers (accept, conflict, deny, hold, audit-in-transaction,
  rollback), invariant assertion, SQL truth table, simulated replicas (no hidden row, relationship,
  note, hold, or unseen tombstone).
- Provider: extend `sync-config.powersync.integration.test.ts` with a live per-row reveal and
  un-reveal of a content entity (closes the feature 04/03 "live reveal of a content row" gap) when
  the service is reachable.
- E2E (Playwright): quick create from name only; offline create/edit/link/delete then reconnect;
  player view without hidden content; VisibilityControls reveal on an entity; type-by-config demo.

## Implementation Sequence

1. Type configuration and pure rules.
2. Tables, migrations, publication.
3. Policies, adapter, facts source, conformance.
4. Sync streams, per-class hold filters (B-3), drift gate.
5. Services and audit declarations (feature 06 contributor row built).
6. Mutation appliers (B-2 session in the applier context).
7. Read routes.
8. Relationship persistence and bound (B-1 refusal); 9. relationship mutations and endpoint
   narrowing.
10. Published directory API.
11–13. Web list/detail, quick create/editor/visibility/session quick actions,
    relationships/attachments.
14. Custom fields. 15. Export and search contributors. 16. Security and product acceptance.
17. Import contributor (after the feature 07 import contract is ratified, B-5).

## Impacted Areas

- `packages/content/` — new.
- `drizzle.config.ts` — schema path; `packages/identity/drizzle/` — new migrations.
- `apps/api/src/modules/content/` — new; `apps/api/src/runtime.ts`, `apps/api/src/main.ts` —
  composition, attachment owner class.
- `apps/api/src/modules/sync/sync-rules.ts` — policies and bindings lists;
  `apps/api/src/modules/sync/routes.ts` — session passed to the authority (B-2).
- `infra/powersync/sync-config.yaml` — compiled content stream, hold filters.
- `apps/api/src/modules/sync/sync-config.integration.test.ts` — drift/derivation for new classes.
- `apps/api/src/modules/audit/contributors.ts` — row `16` built, content declarations composed.
- `apps/api/src/modules/portability/composition.ts` — content exporter registered.
- `packages/sync` (B-2, B-3), `packages/authorization` (B-1) — additive Track A changes.
- `apps/web/src/features/content/` — new; Vite composition of the local `Schema`; app shell mounts
  `ContentQuickCreateHost`.
- `tools/guard/src/rules.ts` — type-ID literal rule.

## Risks and Tradeoffs

- Read-only HTTP means online use without a working local replica cannot write. Accepted: feature
  03 is the platform write path and browser delivery is verified (feature 03 task 08).
- Endpoint narrowing that rewrites relationships (D-07 option A) produces audit events the GM did
  not directly request; they are attributed to the GM who changed the entity.
- One generic table means type-specific queries cannot use per-type columns; custom fields live in
  `fields jsonb` as free-form strings (D-01).
- Personal notes duplicate a small amount of envelope plumbing in a second table; the alternative
  leaks (see Authorization).
- Description display without Markdown rendering (D-10) looks plain; accepted for P0 because it has
  no HTML/XSS surface and needs no data migration to add rendering later.
- Content audit history is online-only (feature 06 excludes per-record classes from audit sync).

## ADRs

- ADR candidate (PRD): single generic entity model with type as configuration. Record as
  `adrs/ADR-001-generic-entity-model.md` in task 01.

## Decisions

All product decisions were delegated by the owner on 2026-10-28 ("Com exceção de commits, pode
fazer tudo"). Rule applied: the proposed default where one existed, otherwise the narrowest,
simplest, most reversible option consistent with the PRD, current code, and MVP scope.

| ID | Question | Decision | Affects |
| --- | --- | --- | --- |
| D-01 | Custom fields free-form or schema-declared per type | Decided (2026-10-28, delegated by owner): free-form label → string value pairs in `fields` (≤ 32 entries, label trimmed 1..64 and unique case-insensitively, value 0..1,000), no per-type declarations — simplest shape, no screen per type, and a later declaration can type the same keys without a migration | tasks 01, 06, 14 |
| D-02 | Scenes owned by feature 16 or feature 18 | Decided (2026-10-28, delegated by owner): `scene` is an enabled feature 16 entity type with no scene-specific behavior; feature 18 owns only the session's current-scene reference and resolves it through the directory — matches FR-002 and feature 18 FR-006 without a second model | task 01 |
| D-03 | Creature/NPC statistics reuse feature 15 rendering | Decided (2026-10-28, delegated by owner): deferred with FR-101 (P1); no statistics data or rendering in P0 — avoids the only Track C internal dependency until P1 is scheduled | — |
| D-04 | Players create or edit campaign entities, or only read | Decided (2026-10-28, delegated by owner): read only — fail-closed; GM-authored content stays GM-controlled, players write personal notes | tasks 03, 05 |
| D-05 | `assistant_gm` same create/update/delete/reveal as `gm` | Decided (2026-10-28, delegated by owner): yes, `owner`, `gm`, `assistant_gm` identical — matches the feature 04 GM-role convention and BDD two-GM scenarios | task 03 |
| D-06 | GM roles get personal notes, or only players | Decided (2026-10-28, delegated by owner): players only; GM roles use the `note` entity type (GM-only by default) — one private-note audience, smallest policy | task 03 |
| D-07 | Hiding an endpoint narrows its relationships (A) or is refused (B) | Decided (2026-10-28, delegated by owner): A, narrow automatically in the same transaction with one audited `visibility.unrevealed` per relationship — never blocks a GM mid-session and never leaves a wider link | tasks 08, 09 |
| D-08 | Relationship kinds configured or free text; initial entries | Decided (2026-10-28, delegated by owner): configured list, no type restrictions: `member_of` (member of / has member), `lives_at` (lives at / has resident), `located_at` (located at / location of), `knows` (knows / known by), `owns` (owns / owned by), `appears_in` (appears in / features), `related_to` (related to / related to) — covers the PRD examples and scenes; adding a kind is configuration | tasks 01, 08 |
| D-09 | Default quick-create type; "one field" is the summary | Decided (2026-10-28, delegated by owner): the one field is `summary`; default type without an entry point is `note` — the most neutral type, changeable afterwards | task 12 |
| D-10 | Rich-text format and editor | Decided (2026-10-28, delegated by owner): Markdown source stored as plain text, edited in a textarea, displayed as escaped plain text with line breaks in P0 — no HTML surface, no dependency, rendering can be added later without migration | tasks 02, 12, 15 |
| D-11 | Limits for name, summary, description, tags | Decided (2026-10-28, delegated by owner): name trimmed 1..200; summary 0..280; description and note body 0..50,000 characters; ≤ 32 tags per entity, each 1..64 after normalization; custom fields per D-01 — bounded queue and replica payloads; raising a limit later is a CHECK-only forward migration | tasks 01, 02 |
| D-12 | Personal notes in campaign export | Decided (2026-10-28, delegated by owner): excluded — export is downloaded by owner/gm roles, who may not read them | task 15 |
| D-13 | Personal notes in the server `SearchIndexer` | Decided (2026-10-28, delegated by owner): excluded; the author finds own notes by device-side search over the local replica — feature 20 then needs no Ownership Rule handling | task 15 |
| D-14 | Session Mode quick-create slot given frozen `SessionQuickAction.invoke` has no input | Decided (2026-10-28, delegated by owner): no contract change; feature 16 ships `SessionQuickAction`s whose `invoke` opens feature 16's own quick-create overlay via `ContentQuickCreateHost` mounted by the app shell; placing them on the Session Mode screen is feature 18's work — keeps the frozen contract and the no-import rule | task 12 |
| D-15 | Personal notes take attachments and relationships in P0 | Decided (2026-10-28, delegated by owner): neither — deviates from the proposed "attachments yes" because feature 05's manifest exporter exports every ready attachment regardless of owner class, which would put a player's private attachment metadata into a GM-downloadable export (contradicts D-12); reversible by adding the owner class later | tasks 09, 13 |
| D-16 | Audit history of a deleted entity readable after delete | Decided (2026-10-28, delegated by owner): hidden (current feature 06 behavior: the facts source returns nothing for tombstones) — no feature 06 change, fail-closed | — |
| D-17 | Offline description editing: local draft vs offline versioned write | Decided (2026-10-28, delegated by owner): local draft, saved under a hold after reconnect — keeps the feature 03 single-writer model | task 12 |
| D-18 | Tag canonical form | Decided (2026-10-28, delegated by owner): case-insensitive, stored lowercase: trim, Unicode NFC, collapse internal whitespace to one space, lowercase, then unique and sorted — one tag per spelling, simplest suggestion matching | task 01 |

## Cross-Feature Blocker Resolutions

Each change is additive, outside `packages/contracts`, and folded into the feature 16 task named.
The executing task updates the owning feature's docs (`Current Facts` / task notes) in the same
change.

- **B-1 (feature 04, task 08).** `VisibilityWriteResult` in `packages/authorization/src/registry.ts`
  gains `{ ok: false, reason: 'invariant_violation' }`. `VisibilityService` maps it to the
  existing rejection `incompatible_visibility` (route: 400 `validation_failed`), records no audit,
  and changes nothing. `runVisibilityAdapterContract` gains one optional check: when the adapter
  supplies an invariant-violating fixture, the write returns `invariant_violation`, the row and
  version are unchanged, and `recordAudit` is not called. Existing adapters compile unchanged
  (union widening is handled in the service switch). The relationship adapter is the first user.
- **B-2 (feature 03, task 06).** `AuthorityMutationContext` in `packages/sync/src/model.ts` gains
  `readonly sessionId?: string`; `AuthorityMutationService.apply(userId, batch)` gains an optional
  `{ sessionId }` argument and passes it through; `apps/api/src/modules/sync/routes.ts` passes the
  authenticated `user.sessionId`. Never taken from the mutation payload. Absent session means
  `hold_required` (fail-closed). Existing appliers ignore the field.
- **B-3 (feature 03, task 04).** The holds query in `sync-config.yaml` replaces
  `resource_class = 'campaign'` with a disjunction derived per registered class with a long-text
  field: holds replicate to a role only if that role may read every row of the class regardless of
  Visibility and the class has no Ownership Rule (`campaign_entity`: `owner`, `gm`,
  `assistant_gm`); otherwise only to the holder (`holder_user_id = auth.user_id()`, used for
  `personal_note`). `campaign` keeps its current rule. Per-row predicates only (no join to content
  tables; PowerSync 1.25.0). The drift test derives the filter from declarations + `decide` and
  fails on tamper; the simulated-replica test covers both classes.
- **B-4 (feature 00/18, task 12).** Designed around without a frozen-contract change (D-14). The
  Session Mode placement itself is deferred to feature 18, which hosts the slot and does not exist
  yet; feature 16 delivers the actions, the host, and tests that `invoke` opens and resolves.
- **B-5 (feature 07, task 17).** Import depends on ratification of
  `../00-platform-foundation/2026-10-27-transaction-aware-import-contract-change.md` and feature 07
  task 06. Until then feature 16's frozen `import` returns `err('content_import_unsupported')` and
  feature 07 preserves the chunk (`contributor_not_transactional`). On ratification, task 17
  implements `ImportableModule`: `validate` declares `defines` with kinds `campaign_entity` and
  `entity_relationship` (the Resource Class names, which feature 05 uses as attachment owner
  classes); `restore` writes only through `context.transaction`, remaps IDs with `mapId`, narrows
  unmapped `players` targets to `gm_only` with `visibility_narrowed_to_gm_only`, and never widens.
  If the note is rejected, import stays disabled and export ships unchanged. Resolved: ratified
  2026-10-28; implemented by task 17 (2026-10-30), which also clamps each imported relationship to
  its imported endpoints (D-07). Chunk custom fields are `{ label, value }` pairs so a free-form
  label is never a JSON key for the feature 07 forbidden-key scanner (task 15).
