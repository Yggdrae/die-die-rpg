# Data Design: Characters

Source: `_prd.md`, `_bdd.md`, `_techspec.md`, feature 04 and 11 data designs, migrations through `0015`.

## Data Inventory

| Data | Source of Truth | Storage | Offline | Sync | Conflict Strategy |
| --- | --- | --- | --- | --- | --- |
| Character | PostgreSQL `characters` | PostgreSQL + device replica | Read and write | Stream `authorized_characters`; create and delete by this feature's applier; edits by feature 11 applications | Edits merge or refuse by guard (feature 11); create and delete versioned |
| GM-only state | PostgreSQL `character_secrets` | PostgreSQL + GM devices only | GM roles | Same stream, `gm_only` rows | Same as above |

## Relational Changes

Migration `0016_characters`. Schema `packages/characters/src/infra/postgres/schema.ts`.

### `characters`

| Column | Type | Rule |
| --- | --- | --- |
| `id` | `uuid` | primary key, client-generated |
| `campaign_id` | `uuid not null` | no FK |
| `owner_user_id` | `uuid not null` | Ownership Rule column; equals `created_by` |
| `system_id`, `system_version` | `text not null` | the campaign's exact pin at creation |
| `state` | `jsonb not null` | feature 11 target state, without GM-only paths |
| `visibility_mode`, `visibility_targets` | as feature 04 | fixed `players:[owner]` |
| `version` | `bigint not null default 1` | bumped by every write |
| `created_at`, `updated_at`, `created_by`, `updated_by`, `deleted_at` | standard | |

### `character_secrets`

| Column | Type | Rule |
| --- | --- | --- |
| `id` | `uuid` | primary key, equals the character's id |
| `campaign_id` | `uuid not null` | |
| `state` | `jsonb not null` | GM-only paths only |
| `visibility_mode`, `visibility_targets` | | fixed `gm_only`, `[]` |
| `version`, `updated_at`, `deleted_at` | | follows the character |

`character_visibility_targets_valid(jsonb)` is owned by this migration. Both tables are published and granted.

## Offline and Sync

The device shows `projectTargetState` over the replica row, plus the secret row on GM devices, plus pending feature 11
applications. Accepted applications and the new rows arrive in one checkpoint. A player's replica never holds a secret
row: the compiled `gm_only` predicate excludes it.

## Lifecycle, Export

Soft delete with tombstone. Exported by `CharacterExporter`, with GM-only state in the chunk, which only export roles
produce. Restored characters belong to the importer.

## Required Data Tests

CHECKs on Visibility, owner, and version; secret rows hidden from players on simulated and live replicas; merge and
guarded refusal on PostgreSQL.

## Open Questions

None. See `_techspec.md`.
