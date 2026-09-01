# Data Design: Campaign Lifecycle

Source: `_prd.md`, `_bdd.md`, feature 01 `_db.md`, feature 03 `_domain.md`, and current repository
schemas. This document precedes `_techspec.md` per the requested Track A authoring order; the
TechSpec must adopt or explicitly amend these persistence decisions.

## Sources of Truth

PostgreSQL is authoritative for campaigns, system pins, module pins, and namespaced settings.
SQLite/WASM holds synchronized replicas for local-first reads and offline creation. System and
module package contents are not copied into campaign tables; only immutable identifiers and pinned
versions are stored.

| Data | Writer | Readers | Offline behavior |
| --- | --- | --- | --- |
| Campaign | Feature 02 application service | Published campaign context/list APIs | Create/update locally, then synchronize |
| System pin | Dedicated feature 02 version-update use case | Published context API | Read locally; explicit update may queue |
| Module pins | Creation use case in P0 | Published context/export APIs | Read locally |
| Namespaced setting | Registered namespace owner through feature 02 | Context API and namespace owner | Versioned local write |
| Owner membership | Feature 01 through a narrow transaction participant | Feature 01 actor resolver | Created atomically with campaign |

## PostgreSQL Schema

All IDs are UUIDs, instants are `timestamptz`, and synchronized mutable records carry `version
bigint >= 1` plus `deleted_at`. JSON values are validated with the owning TypeBox schema before
write; JSONB is storage, not validation.

### `campaigns`

| Column | Constraints / meaning |
| --- | --- |
| `id uuid` | primary key; client-generated for offline creation |
| `name text` | trimmed, 1–120 Unicode code points |
| `description text` | at most 10,000 Unicode code points |
| `game_mode text` | non-empty manifest-declared identifier |
| `created_by uuid` | feature 01 user ID; retained historical attribution |
| `version bigint` | starts at 1; increments on mutable campaign changes |
| `created_at`, `updated_at timestamptz` | required |
| `deleted_at timestamptz` | nullable tombstone |

Indexes: active campaigns by `updated_at`; creator attribution; tombstone cleanup candidate. A
campaign row cannot hard-delete while owned feature rows, pins, settings, or memberships remain.

### `campaign_system_pins`

| Column | Constraints / meaning |
| --- | --- |
| `campaign_id uuid` | primary key and restricted FK to `campaigns` |
| `system_id text` | non-empty package identifier |
| `system_version text` | exact validated package version string |
| `updated_at timestamptz` | required |

There is exactly one row per campaign. It is inserted during creation and changed only by the
explicit version-update use case. Database privileges expose no generic update path to other
modules. An unresolved pin fails closed; no fallback version is persisted.

### `campaign_module_pins`

| Column | Constraints / meaning |
| --- | --- |
| `campaign_id uuid` | restricted FK to `campaigns` |
| `module_id text` | non-empty identifier |
| `module_version text` | exact compatible installed version |
| `created_at timestamptz` | required |

Primary key `(campaign_id, module_id)`. P0 writes this set only at campaign creation; module
enable/disable after creation is deferred. This satisfies `modules.lock` without a speculative
module engine.

### `campaign_settings`

| Column | Constraints / meaning |
| --- | --- |
| `campaign_id uuid` | restricted FK to `campaigns` |
| `namespace text` | package-style stable owner key, 1–100 ASCII characters |
| `value jsonb` | validated by registered namespace schema |
| `member_visible boolean` | controls audit redaction and sync declaration |
| `version bigint` | starts at 1; required expected-version writes |
| `updated_at timestamptz` | required |
| `updated_by uuid` | authoritative actor user ID |
| `deleted_at timestamptz` | nullable tombstone |

Primary key `(campaign_id, namespace)`. Namespace schemas are code registrations, not database
rows. Unknown namespaces reject before persistence. One namespace owner may not update another.

## Exactly One Active Owner

Feature 01 owns `identity_campaign_memberships`; feature 02 owns campaign existence. The invariant
spans both and must be database-enforced.

Use one PostgreSQL transaction plus a deferred constraint trigger:

- on campaign insert/update of `deleted_at`, and membership insert/update/delete;
- at transaction end, every non-deleted campaign touched by the transaction must have exactly one
  active membership with role `owner`;
- deleted campaigns must retain their membership tombstones but are exempt from the active-owner
  count after deletion commits;
- the feature 01 partial unique index still enforces at most one owner immediately.

Campaign creation inserts campaign, pin rows, module pins, settings, and initial owner membership
in the same transaction. Ownership transfer locks all active campaign memberships in stable user-ID
order. `READ COMMITTED` plus row locks, the partial unique index, and the deferred trigger is the
selected mechanism. Retry serialization/deadlock errors at the application boundary with a bounded
attempt count.

## Offline and Conflict Rules

- Client-generated IDs make an offline-created campaign stable across synchronization.
- The complete creation aggregate is one durable local transaction and one causally ordered upload
  group. Invitations are separate online-owned feature 01 mutations queued after campaign acceptance.
- Campaign details, settings, soft delete, and pin update require `expectedVersion`.
- Concurrent version-pin or visibility-relevant setting writes yield explicit conflicts.
- System/module package availability is checked locally before recording creation and checked again
  at authority acceptance; a missing authoritative package rejects as a deferred conflict/error.
- Tombstones prevent deleted campaigns or settings from reappearing.

The local replica contains only campaigns allowed by current membership. Membership removal and
campaign deletion trigger feature 03 replica cleanup.

## Lifecycle, Retention, and Export

- Soft delete is permanent in P0; restore and hard-delete UI are out of scope.
- Campaign tombstones are retained until feature 03's safe-purge watermark covers every eligible
  client and all owned feature retention rules permit deletion. No fixed P0 hard-delete deadline.
- Settings tombstones follow the same watermark.
- Pins remain with the campaign tombstone so import/export and audit can explain the rules context.
- Feature 07 exports campaign fields, exact system/module pins, and exportable settings. It never
  exports pending sync bookkeeping or owner credentials.
- Import assigns new campaign and owned-record IDs and creates a new owner membership atomically.

## Migration

1. Add feature 02 Drizzle schema and a forward-only migration for the four tables.
2. In the same release, add campaign foreign keys to feature 01 invitation/membership tables and
   the deferred owner constraint trigger. There is no production backfill for initial creation.
3. Add tables to the sync publication only after feature 04 predicates deny unauthorized rows.
4. Rollback before production data may drop new empty tables; after data exists, rollback is
   application rollback only. Schema migrations remain forward-only.

## Required Data Tests

- Creation commits every owned row and exactly one owner, or commits nothing.
- Deferred trigger rejects an ownerless non-deleted campaign at commit.
- Concurrent creation/retry does not produce duplicate campaigns or owners.
- Detail and setting updates cannot change system/module pins.
- Only the explicit version-update repository method changes the system pin.
- Namespace registration and TypeBox validation precede writes.
- Offline creation drains in causal order and remains idempotent.
- Soft delete synchronizes a tombstone and removes context from default reads.
- No other feature package can import feature 02 schema internals.

