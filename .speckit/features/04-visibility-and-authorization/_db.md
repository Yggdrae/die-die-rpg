# Data Design: Visibility and Authorization

Source: `_prd.md`, `_bdd.md`, `_domain.md`, frozen `Visibility`/`EntityEnvelope` contracts, and
feature 03 `_db.md`.

## Persistence Decision

Feature 04 owns the policy and storage contract, not a central copy of every grant. The
authoritative `Visibility` value remains on the resource record owned by its feature, as required
by the frozen `EntityEnvelope`. Creating a second central `visibility_grants` source of truth would
allow API and sync decisions to diverge and would violate feature-owned data boundaries.

The feature-list phrase “owns visibility_grant” therefore means it owns the normalized value,
validation, decision semantics, sync predicate generation, and migration rules. Content features
persist that value in their own tables and may mutate it only through the feature 04 service.

Feature 04 adds no P0 PostgreSQL table. Its data document is still required because visibility is
persisted, synchronized, exported, versioned, and deleted across every content table.

## Standard Relational Representation

Every synchronized content table stores:

| Column | Rule |
| --- | --- |
| `visibility_mode text` | check in `gm_only`, `everyone`, `party`, `players` |
| `visibility_targets jsonb` | canonical JSON array of UUID strings; see checks below |
| `version bigint` | required optimistic-concurrency version |
| `deleted_at timestamptz` | nullable tombstone |

Representation checks:

- `gm_only` and `everyone` require `visibility_targets = '[]'::jsonb`.
- `players` and `party` require a non-empty array of unique, lexicographically sorted UUIDs.
- application validation uses the frozen TypeBox `Visibility` schema before SQL.
- database checks enforce mode/empty-vs-nonempty shape; current-membership validity is checked in
  the same application transaction because it spans feature-owned tables.

The application maps the columns to the frozen discriminated union. A feature may store the union
as one JSONB column instead only if it proves equivalent constraints, indexing, and sync predicate
generation. One repository must not mix representations.

## Ownership Rules

Resource-specific ownership facts stay with the resource owner. An author-private note stores
`author_user_id` in its owning table. Its declaration marks that field as an ownership predicate;
feature 04 does not copy it. Sync predicates join/compare the authenticated user parameter to that
column and do not grant a GM-role override.

Party targets fail closed in P0. No party membership table is introduced here. A future party
owner registers a resolver and migrations only when the P1 feature ships.

## Declaration Registry

Resource Class declarations and namespace/capability schemas are code registrations validated at
application composition. They are not mutable product data and receive no database table.

Registration fails on duplicate class IDs, missing capability outcomes, absent sync predicates,
or incompatible storage adapters. Startup fails rather than serving a partially authorized class.
The shared matrix test is the durable evidence for registry completeness.

## Visibility Mutation Transaction

The resource owner supplies a narrow adapter that locks and updates one resource without exposing
its schema. Feature 04 performs:

1. resolve authoritative Actor and current target memberships;
2. load the registered declaration and resource facts;
3. decide reveal capability;
4. lock the resource row and compare expected `version`;
5. normalize set-union or set-subtraction of target IDs;
6. convert an empty targeted set to `gm_only`;
7. persist normalized Visibility and increment `version`;
8. enqueue the feature 06 audit event in the same local/server mutation envelope.

Concurrent changes against the same version produce one winner and one conflict. Automatic retry
must not silently combine a rejected visibility decision after memberships changed.

## Synchronization

Feature 04 compiles the same declaration into provider-neutral row predicates consumed by feature
03. The initial PowerSync adapter translates them to bucket/subscription rules.

Rules use current authoritative membership, record campaign, mode/targets, and ownership fields.
They must produce the same truth table as the pure application Decision. CI enumerates all MVP
roles, modes, cross-campaign cases, targeted membership cases, deletion cases, and author-private
overrides against both evaluators.

When visibility narrows or membership changes, the provider emits row removal to affected replicas.
No hidden-row tombstone or total is sent to a client that never received the row. Feature 05 uses
the same removal signal to delete cached/pinned bytes.

## Indexing

Each owning table needs at least:

- active campaign listing index beginning with `campaign_id` and excluding tombstones;
- `visibility_mode` where it materially narrows sync queries;
- GIN on `visibility_targets` only after query evidence justifies it; small targeted arrays may be
  cheaper without one;
- author/owner index for Resource Classes with author-private rules.

Do not add a global cross-feature visibility index. PostgreSQL cannot index unrelated owner tables
as one source without rebuilding the coupling this feature avoids.

## Lifecycle, Retention, and Export

- Visibility lives as long as its resource, including on tombstones until feature 03 permits purge.
- Removing a member does not rewrite every historical target array. Current membership is required
  at Decision time, so stale IDs grant nothing. Optional compaction may remove stale targets later
  through a versioned migration, never as an authorization prerequisite.
- Export serializes the frozen `Visibility` value with each record. Import validates it before
  write and remaps targeted user IDs only when the contributor has an approved mapping; otherwise
  it fails closed to `gm_only` with an explicit import warning, never widens to `everyone`.
- Un-reveal removes future server/sync access but cannot revoke an exported file or knowledge.

## Migration Rules

For a new content table, Visibility columns and constraints exist in its first migration. For an
existing table missing Visibility:

1. expand with nullable columns;
2. backfill `gm_only` (the safe default) in bounded batches;
3. verify no null/invalid row and API/sync equivalence;
4. add not-null/check constraints;
5. enable synchronization only after verification.

Never default historical content to `everyone`. A rollback disables the new resource class before
removing policy code; data columns remain until a later reviewed migration.

## Required Data Tests

- Database checks reject invalid mode/target combinations and duplicates.
- Current non-member targets reject a Visibility change.
- Removed-member target IDs grant no access without requiring immediate rewrite.
- Versioned concurrent reveals produce one explicit conflict, not a lost grant.
- Empty target subtraction stores `gm_only`.
- API and sync predicates agree for the exhaustive shared matrix.
- Player local databases contain no hidden row, count, or tombstone.
- Author-private notes never reach GM-role replicas.
- Export/import never widens Visibility.

