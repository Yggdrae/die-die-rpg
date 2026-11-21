# Data Design: Campaign Content and Entities

Source: `_prd.md`, `_bdd.md`, `_techspec.md`, feature 04 `_db.md` (standard Visibility
representation), feature 03 `_db.md` (replica, queue, holds, tombstones), feature 05 `_db.md`
(attachment owner reference), feature 06 `_db.md` (audit routing), and current schemas in
`packages/*/src/infra/postgres/schema.ts` and `packages/identity/drizzle/0000–0005`.

## Data Inventory

| Data | Source of Truth | Storage | Offline | Sync | Conflict Strategy |
| --- | --- | --- | --- | --- | --- |
| Campaign entity (all types) | PostgreSQL `content_entities` | PostgreSQL + device SQLite replica | Yes, read and write | Feature 04-compiled stream; writes through `POST /sync/mutations` and the feature 16 applier | Versioned structured fields; `description` single writer through feature 03 holds |
| Personal note | PostgreSQL `content_personal_notes` | PostgreSQL + author's replica only | Yes, read and write (author) | Compiled stream with Ownership Rule | Versioned; `body` single writer through feature 03 holds |
| Entity relationship | PostgreSQL `content_entity_relationships` | PostgreSQL + device SQLite replica | Yes, read and write | Compiled stream; visibility bounded by endpoints (D-07 option A) | Versioned; no long text; insert/tombstone only |
| Tags | Column on the entity | Same row | Yes | With the entity | With the entity version |
| Tag suggestions | Derived | Computed from the actor's visible rows | Yes | None (derived) | N/A |
| Type and relationship-kind configuration | Code (`packages/content`) | Source code, versioned with the app | Yes (bundled) | None | N/A |
| Attachments of an entity | Feature 05 `attachments` (owner class `campaign_entity` only, D-15) | Feature 05 | Pinned set only (feature 05) | Not replicated; authorized offline set (feature 05) | Feature 05 |
| Long-text holds | Feature 03 `sync_long_text_holds` | Feature 03 | Feature 03 | Platform holds query, per-class filter added here (B-3) | Feature 03 |
| Long-text drafts (D-17) | Device | Device-local, unsynchronized store | Yes (device only) | None; cleared by the feature 03 `ReplicaPurgeListener` | N/A (saved later as a held write) |
| Audit events | Feature 06 stores | Feature 06 | Online only (per-record classes are excluded from audit sync) | Feature 06 | Feature 06 |

No tag table is created. A `tag` table shared across entities would carry tags of hidden
entities and need its own visibility rule; deriving suggestions from rows the actor already holds
cannot leak (BR-009). The feature-list entry "Owns (data): tag" is satisfied by the tag column.

No blob, CRDT, or WebSocket data. Feature 05 owns bytes; Yjs is V1 (FR-203).

## Ownership and Access

| Data | Owner | Read | Write | Visibility |
| --- | --- | --- | --- | --- |
| `content_entities` | feature 16 | feature 04 decision on class `campaign_entity` | feature 16 service/applier after feature 04 decision; Visibility only through feature 04 `VisibilityService` | standard columns, default `gm_only` |
| `content_personal_notes` | feature 16 | author only (Ownership Rule, no exempt role) | author only | fixed `players:[author]`; no `reveal` capability |
| `content_entity_relationships` | feature 16 | feature 04 decision on class `entity_relationship` | feature 16 after decision; Visibility only through feature 04 | standard columns, default `gm_only`, never wider than either endpoint (D-07 option A) |

Role capability matrices are in `_techspec.md` (D-04 players read only, D-05 all GM roles equal,
D-06 personal notes for players only). No other feature
reads or writes these tables (`../_index.md`, rule 1). Features 17, 18, 19 use the published
module API; features 07 and 20 use the registry contributors.

## Relational Changes

All three tables are new. One forward-only migration per task that introduces them, generated with
`bun run db:generate` into `packages/identity/drizzle` (next free number after `0005`; the
number is assigned at generation time). Schema source: `packages/content/src/infra/postgres/schema.ts`,
added to `drizzle.config.ts` `schema` list.

### `content_entities`

| Column | Type | Rule |
| --- | --- | --- |
| `id` | `uuid` | primary key; client-generated (offline create) |
| `campaign_id` | `uuid not null` | campaign scope; no FK to `campaigns` (cross-feature table) |
| `type` | `text not null` | `^[a-z][a-z0-9_]{0,63}$`; membership in the type registry is checked by the application, not the database, so removing a type never invalidates rows |
| `name` | `text not null` | trimmed, 1..200 characters (D-11) |
| `summary` | `text not null default ''` | the quick-create "one line"; 0..280 characters (D-11) |
| `description` | `text not null default ''` | Markdown source as plain text (D-10); 0..50,000 characters (D-11); long-text field path `description` |
| `tags` | `jsonb not null default '[]'` | array of at most 32 unique, sorted, lowercase-normalized strings (D-18), each 1..64 (frozen `Tag`) (D-11) |
| `fields` | `jsonb not null default '{}'` | custom fields (D-01): object of at most 32 free-form label → string value pairs; label trimmed 1..64, unique case-insensitively; value 0..1,000 characters |
| `metadata` | `jsonb not null default '{}'` | envelope `metadata` |
| `visibility_mode` | `text not null` | feature 04 standard |
| `visibility_targets` | `jsonb not null default '[]'` | feature 04 standard |
| `version` | `bigint not null default 1` | `>= 1` |
| `created_at`, `updated_at` | `timestamptz not null` | authority time on accept |
| `created_by`, `updated_by` | `uuid not null` | authoritative actor user IDs |
| `deleted_at` | `timestamptz` | tombstone |

### `content_personal_notes`

Same envelope columns as `content_entities` except `type` (fixed `note` in the replica mapping),
`summary`, and `fields`; adds:

| Column | Type | Rule |
| --- | --- | --- |
| `author_user_id` | `uuid not null` | Ownership Rule column; equals `created_by`; never changes |
| `body` | `text not null default ''` | Markdown source as plain text (D-10), 0..50,000 characters (D-11); long-text field path `body` |

Visibility CHECK additionally requires `visibility_mode = 'players' AND visibility_targets =
jsonb_build_array(author_user_id::text)`. The note's Visibility can never widen.

### `content_entity_relationships`

| Column | Type | Rule |
| --- | --- | --- |
| `id` | `uuid` | primary key; client-generated |
| `campaign_id` | `uuid not null` | scope |
| `source_entity_id`, `target_entity_id` | `uuid not null` | composite FK `(campaign_id, x) -> content_entities (campaign_id, id)` `ON DELETE RESTRICT`; tombstoned endpoints remain referenced (broken link) |
| `kind` | `text not null` | `^[a-z][a-z0-9_]{0,63}$`; checked against configured kinds by the application (D-08); never updated (kind change = tombstone + new link) |
| `visibility_mode`, `visibility_targets` | as above | default `gm_only` |
| `version`, `created_*`, `updated_*`, `deleted_at` | as above | |

Relationships are stored once, directed source -> target. Bidirectional navigation is a query on
either column; the inverse label comes from kind configuration (D-08). Both endpoints are
`campaign_entity` rows; personal notes are never endpoints (D-15).

### Constraints / Indexes

- Feature 04 representation on all three tables, copied from the template in
  `packages/authorization/src/visibility.integration.test.ts`: an immutable SQL function validating
  a sorted, unique, lowercase-UUID JSON array, a mode CHECK (`gm_only|everyone|party|players`), and
  a targets CHECK (`[]` for `gm_only`/`everyone`, non-empty otherwise). One shared function owned
  by this feature's migration (`content_visibility_targets_valid(jsonb)`).
- `version >= 1` on all three tables.
- `content_entities`: unique `(campaign_id, id)` (FK target); CHECKs on `type` pattern, name
  length/trim, summary and description length (D-11), `jsonb_typeof(tags) = 'array'` and
  `jsonb_array_length(tags) <= 32`, `jsonb_typeof(fields) = 'object'`,
  `jsonb_typeof(metadata) = 'object'`. `content_personal_notes`: name length/trim and body length
  (D-11). Tag element shape/order is validated by the application
  with the frozen `Tag` schema; a CHECK function may mirror it.
- `content_entity_relationships`: CHECK `source_entity_id <> target_entity_id`; partial unique
  `(campaign_id, source_entity_id, target_entity_id, kind) WHERE deleted_at IS NULL`.
- Indexes (feature 04 `_db.md` "Indexing"):
  - `content_entities (campaign_id, type) WHERE deleted_at IS NULL`;
  - `content_entities (campaign_id, updated_at DESC) WHERE deleted_at IS NULL` for default listing;
  - GIN `content_entities (tags)` only after query evidence (tag filter can scan the campaign
    partial index at MVP sizes);
  - `content_entity_relationships (campaign_id, source_entity_id)` and
    `(campaign_id, target_entity_id)`;
  - `content_personal_notes (campaign_id, author_user_id)`.
- Name-fragment search: device-side over the local replica (`LIKE`/FTS per the feature 00 spike
  answer); server-side `ILIKE` on the campaign partial index is acceptable at MVP sizes. No
  trigram index without evidence.

## Offline and Sync

- Local representation: provider-managed replica tables `content_entities`,
  `content_personal_notes`, `content_entity_relationships`, with the approved columns of
  `SYNC_RULE_BINDINGS`, added to the browser `Schema` passed through the `schema` option of
  `packages/sync/src/browser.ts` (default `SyncBookkeepingSchema`). JSON columns arrive as text
  (observed in the provider round trip). The feature 16 local repository maps rows to
  `entitySchema(...)` records so `SyncedRepository<T extends EntityEnvelope>` applies.
- Sync direction: server -> client by compiled stream queries; client -> server only through
  `POST /sync/mutations` and the feature 16 `MutationApplier`s. No generic table write.
- Filter/partition rule: the compiled feature 04 predicate per class
  (`compileProviderQueries`, PowerSync dialect); the YAML queries are compiled output guarded by
  the drift test in `apps/api/src/modules/sync/sync-config.integration.test.ts`. Personal notes add
  `owner_is_requester(author_user_id)` with no GM-role override.
- Publication: a forward migration `ALTER PUBLICATION powersync ADD TABLE` plus
  `GRANT SELECT ... TO powersync_replicator` for the three tables
  (`0003_least_privilege_sync_publication.sql` contract; the publication and replication-role
  tests enforce that streamed tables are published and granted and nothing else).
- Provider constraint: PowerSync 1.25.0 does not enforce equality against a joined row, so every
  content stream query is a per-row predicate on its own table plus the requester's membership
  row. This is why relationship visibility is a write-time invariant, not a sync-time join.
- Holds: `sync_long_text_holds` currently replicates only `resource_class = 'campaign'`. Feature 16
  adds per-class filters derived from the declarations (techspec B-3): holds on `campaign_entity`
  reach the roles that may read every row of that class irrespective of Visibility (`owner`, `gm`,
  `assistant_gm` under the approved matrix); holds on `personal_note` reach only the holder
  (`holder_user_id = auth.user_id()`). The publication already contains the holds table.
- Conflict behavior: structured fields are versioned (`expectedVersion` required by
  `SyncedRepository`); a stale upload returns `conflict` with `currentValue` and lands in
  `sync_conflicts` for the shared surface. `description`/`body` writes additionally require an
  active hold whose version matches for the uploading session (feature 03
  `LongTextHoldService.mayWriteWithin`, inside the write transaction with the hold row locked;
  session supplied by the authority per B-2). Tags and custom
  fields are set as a whole with the entity version (no per-key merge in P0).
- Reconnect behavior: queued mutations drain in causal order; a role downgrade while offline makes
  the authority reject the queued writes (conflict/error outcome, not silent loss); visibility
  narrowing and revocation remove rows from the replica (feature 03/04).

## Visibility Invariant for Relationships (D-07, option A)

Sync predicates evaluate one row at a time (feature 04 AST nodes: `member_role_in`,
`visibility_mode_in`, `targets_include_requester`, `owner_is_requester`, ...). A relationship row
cannot be filtered by its endpoints' Visibility at sync time. The data rule is therefore an
invariant maintained on write:

> For every live relationship R with endpoints S and T:
> `R.visibility ⊆ S.visibility ∩ T.visibility` (in the feature 04 decision sense), where
> `gm_only` is the bottom, `everyone` the top, and `players(A) ∩ players(B) = players(A ∩ B)`,
> empty -> `gm_only`. `party` is unreachable in P0.

Maintenance, all in the feature 16 PostgreSQL transaction:

1. Relationship create/reveal: rejected when it would violate the invariant. Create may clamp the
   default (`gm_only` always satisfies it).
2. Endpoint narrowing (any entity Visibility change through the feature 16 `VisibilityAdapter`
   whose new Visibility no longer contains a live relationship's Visibility): the adapter narrows
   each such relationship to `R ∩ S ∩ T` in the same transaction, increments its version, and
   records one `visibility.unrevealed` audit event per narrowed relationship through
   `recordWithin` on the same executor (D-07 option A).
3. Endpoint soft delete: no change. Every actor who could read R could read the endpoint and
   receives its tombstone, so the link renders as broken without disclosure.
4. Lock order: entity rows by ascending ID, then relationship rows (`FOR UPDATE`), in both the
   entity adapter and the relationship applier/adapter, so a concurrent link create and endpoint
   narrowing serialize.

Data test: a database-level assertion query (no live row violates the invariant) runs after every
relationship and visibility integration test.

## Blob Storage

N/A. Attachments are feature 05 rows with `owner_resource_class` (`campaign_entity` or
`personal_note`) and `owner_resource_id`. Feature 05 authorizes through feature 04
`ContentAccess.authorizeResource` against this feature's registered adapter/facts source.

## Collaborative Documents

- CRDT needed: No (PRD non-goal; FR-203 V1).
- Long text: single writer through feature 03 holds, field paths `description` and `body`.

## Lifecycle, Retention, and Export

- Tombstones follow the feature 03 watermark rule (90-day minimum, every eligible subscriber past
  it, no pending mutation referencing it). Purge is report-only platform-wide today
  (`reportTombstonePurge`); this feature supplies `TombstoneRef` candidates only when platform purge
  is enabled. Relationship rows referencing an entity block that entity's physical purge
  (`ON DELETE RESTRICT`); purge order is relationships first. Rule (2026-10-28): an entity
  tombstone referenced by any relationship row is retained, so broken links keep resolving (PRD
  constraint); it becomes purge-eligible only after every referencing relationship is purged.
- Visibility lives with the row, including on tombstones.
- Export (feature 07): entities and relationships with their frozen `Visibility`, deterministic
  order (feature 07 double-read checksum). Personal notes are excluded (D-12). Import (task 17,
  after the feature 07 import contract is ratified, B-5) remaps IDs and narrows unmapped targeted
  Visibility to `gm_only` with a warning.
- Audit history of a deleted entity: hidden after delete (D-16). Feature 06 hides events whose
  target facts are missing; the facts source returns `undefined` for tombstones (adapter contract
  `tombstone_excluded`).

## Migration and Backfill

- New tables are created with Visibility columns and CHECKs in their first migration (feature 04
  `_db.md` "Migration Rules"); no backfill.
- Order: (1) entities + personal notes tables and publication; (2) policies registered and drift
  gate updated in the same change as the YAML; (3) relationships table, publication, policy.
  Streams for a table ship only after its policy, adapter contract, and truth table pass.
- Rollback/recovery: forward-only. Disable a class by removing its stream query and policy
  registration in one change (the drift gate keeps them equal); tables remain.

## Data Integrity Risks

- Relationship wider than an endpoint leaks the endpoint ID -> write-time invariant (D-07 option
  A), assertion query in tests.
- Personal note reaching a GM replica -> separate table and class with Ownership Rule; sharing a
  table with `campaign_entity` would let the GM-role branch of the compiled predicate match
  `players:[author]` rows, because the AST has no "column equals constant" node to separate them.
- Hold row naming a hidden record -> per-class hold filter; the current fail-closed
  `resource_class = 'campaign'` stays until the filter and its drift test land.
- Removed type in configuration -> no CHECK on type membership; existing rows stay valid.
- JSON columns arriving as text locally -> local repository parses and validates with TypeBox
  before returning records.

## Required Data Tests

- CHECKs reject invalid Visibility representations, invalid type/kind tokens, self-links,
  duplicate live links, non-author personal-note Visibility.
- Adapter conformance (`runVisibilityAdapterContract`, 10 checks incl. `tombstone_excluded`) for
  `campaign_entity` and `entity_relationship`.
- SQL truth table (PostgreSQL dialect) and in-process truth table agree with `decide` for all three
  classes, tombstones included.
- Invariant assertion after relationship reveal, endpoint narrowing, endpoint delete.
- Player replicas contain no `gm_only` entity, hidden relationship, other author's note, hidden
  hold, or unseen tombstone.
- Concurrent versioned writes produce one winner and one conflict.

## Open Questions

None. D-01, D-07, D-10, D-11, D-12, D-15, D-16, D-17, D-18 were decided on 2026-10-28 (delegated by
the owner); see `_techspec.md` "Decisions".
