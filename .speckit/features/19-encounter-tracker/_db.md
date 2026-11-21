# Data Design: Encounter Tracker

Source: `_prd.md`, `_bdd.md`, `_techspec.md`, feature 03, 04, 11, 15, 16, 18 data designs, migrations through `0017`.

## Data Inventory

| Data | Source of Truth | Storage | Offline | Sync | Conflict Strategy |
| --- | --- | --- | --- | --- | --- |
| Encounter | PostgreSQL `encounters` | PostgreSQL + every member's replica | Read (members), write (GM roles) | Stream `authorized_encounters` | Versioned; a stale change is a feature 03 conflict |
| GM notes | PostgreSQL `encounter_gm_notes` | PostgreSQL + GM-role replicas | GM roles | Same stream, `gm_only` | Versioned; explicit conflict |
| Participant | PostgreSQL `encounter_participants` | PostgreSQL + permitted replicas | Read (permitted), write (GM roles) | Same stream, per-row Visibility | Versioned for its own fields; conditions merge through feature 11 |
| Instance state | PostgreSQL `encounter_participant_states` | PostgreSQL + GM-role replicas | GM roles | Same stream, `gm_only` | Feature 11 semantic operations (merge or guarded refusal) |
| Character state | Feature 15 | Its own tables | Its own | Its own | Feature 11 |

## Relational Changes

Migration `0018_encounters`. Schema `packages/encounters/src/infra/postgres/schema.ts`. No foreign keys to other
features' tables.

### `encounters`

| Column | Type | Rule |
| --- | --- | --- |
| `id` | `uuid` | primary key, client-generated |
| `campaign_id` | `uuid not null` | |
| `session_id` | `uuid` | a feature 18 session ID; not checked across features |
| `name` | `text not null` | 1 to 120 characters |
| `status` | `text not null` | `active`, `ended` |
| `started_at`, `ended_at` | `timestamptz` | `ended_at` set exactly when `status = 'ended'`, not before `started_at` |
| `environment` | `text not null` | at most 2,000 characters |
| `location_id` | `uuid` | a feature 16 entity ID; not checked across features |
| `visibility_mode`, `visibility_targets` | as feature 04 | fixed `everyone`, `[]` |
| `version`, `created_at`, `updated_at`, `created_by`, `updated_by`, `deleted_at` | standard | no delete in P0 |

### `encounter_gm_notes`

`id` (equals the encounter's), `campaign_id`, `body` (at most 5,000 characters), fixed `gm_only`, standard.

### `encounter_participants`

| Column | Type | Rule |
| --- | --- | --- |
| `id` | `uuid` | primary key, client-generated |
| `campaign_id`, `encounter_id` | `uuid not null` | the encounter exists in the campaign |
| `label` | `text not null` | 1 to 120 characters |
| `source_kind` | `text not null` | `character` or `entity` |
| `source_id` | `uuid not null` | a feature 15 character or feature 16 entity ID |
| `position` | `integer not null` | `>= 0`, display order |
| `conditions` | `jsonb not null` | object of numbers: the conditions declared `everyone` (entity participants only) |
| `visibility_mode`, `visibility_targets` | | `everyone` or `gm_only`, `[]` |
| `version` | `bigint` | bumped by this feature's own writes only (reveal, removal), not by feature 11 |
| standard | | removal is a tombstone (`deleted_at`) |

Labels are numbered on the device (D-04) and not unique in the database: two offline devices adding "Bandit" must
both be accepted.

### `encounter_participant_states`

`id` (equals the participant's), `campaign_id`, `state` (`jsonb`, the instance state except public conditions, at
most 64 KiB), fixed `gm_only`, standard. Only entity participants have one. Written at the participant's insert and
afterwards only by the feature 11 adapter, which bumps its version.

All four tables are published to PowerSync and granted to `powersync_replicator`.

## Offline and Sync

- Every change is local first through feature 03 repositories. An ad hoc entity, then its participant, are queued in
  that order. The device shows an entity participant's initial state computed from the pinned package
  (`initialCharacterState`), exactly as the authority computes it, until the state row arrives.
- Stream `authorized_encounters`: encounters for every member, GM notes and instance states for GM roles only
  (compiled `gm_only`), participants by their own Visibility.

## Lifecycle, Export

- Encounters are records: no delete in P0. Campaign deletion removes them with the campaign's other rows.
- Exported by `EncounterExporter` (`encounters`). Restored to the importer: the session through
  `mapId('campaign_session', …)`, the location through `mapId('campaign_entity', …)`, both cleared when unmapped; a
  participant's source through `mapId('character' | 'campaign_entity', …)`, the participant dropped when unmapped.
  Each with a warning.

## Required Data Tests

CHECKs on status, end time, Visibility, text bounds, and source kinds; instance states and GM notes absent from a
player replica (simulated and live); a hidden participant absent from a player replica.

## Open Questions

None. See `_techspec.md`.
