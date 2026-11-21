# Data Design: Session Mode

Source: `_prd.md`, `_bdd.md`, `_techspec.md`, feature 03, 04, 06, 16 data designs, migrations through `0016`.

## Data Inventory

| Data | Source of Truth | Storage | Offline | Sync | Conflict Strategy |
| --- | --- | --- | --- | --- | --- |
| Session | PostgreSQL `campaign_sessions` | PostgreSQL + every member's replica | Read (members), write (GM roles) | Stream `authorized_sessions` | Versioned; a stale change is a feature 03 conflict |
| GM notes | PostgreSQL `session_gm_notes` | PostgreSQL + GM-role replicas only | GM roles | Same stream, `gm_only` rows | Versioned; explicit conflict, never last-write-wins |
| Log entry | PostgreSQL `session_log_entries` | PostgreSQL + permitted replicas | Read (permitted), write (GM roles) | Same stream, per-row Visibility | Immutable, insert only |
| Rolls and effects in the log | Features 09, 11 | Their own tables | Their own | Their own streams | Theirs |

## Relational Changes

Migration `0017_sessions`. Schema `packages/sessions/src/infra/postgres/schema.ts`. No foreign keys to other features'
tables.

### `campaign_sessions`

| Column | Type | Rule |
| --- | --- | --- |
| `id` | `uuid` | primary key, client-generated |
| `campaign_id` | `uuid not null` | |
| `number` | `integer not null` | assigned by the authority, `>= 1`, unique per campaign |
| `status` | `text not null` | `active`, `paused`, `ended` |
| `started_at` | `timestamptz not null` | device time of the start |
| `ended_at` | `timestamptz` | set exactly when `status = 'ended'`, not before `started_at` |
| `current_scene_id` | `uuid` | a feature 16 entity ID; not checked across features |
| `participant_user_ids` | `jsonb not null` | array of user IDs, at most 64 |
| `visibility_mode`, `visibility_targets` | as feature 04 | fixed `everyone`, `[]` |
| `version` | `bigint not null default 1` | bumped by every write |
| `created_at`, `updated_at`, `created_by`, `updated_by`, `deleted_at` | standard | no delete in P0 |

Partial unique index `campaign_sessions_open_idx` on `campaign_id` where `status <> 'ended'`: one open session per
campaign. Unique `(campaign_id, number)`.

### `session_gm_notes`

| Column | Type | Rule |
| --- | --- | --- |
| `id` | `uuid` | primary key, equals the session's ID |
| `campaign_id` | `uuid not null` | |
| `body` | `text not null` | at most 20,000 characters |
| `visibility_mode`, `visibility_targets` | | fixed `gm_only`, `[]` |
| `version`, `created_at`, `updated_at`, `created_by`, `updated_by`, `deleted_at` | standard | |

### `session_log_entries`

| Column | Type | Rule |
| --- | --- | --- |
| `id` | `uuid` | primary key, client-generated |
| `campaign_id`, `session_id` | `uuid not null` | the session exists in the campaign |
| `kind` | `text not null` | `note`, `scene`, `status`, `reveal` |
| `text` | `text not null` | `note`: 1 to 500 characters; `status`: `started`, `paused`, `resumed`, `ended`; `scene`, `reveal`: empty |
| `subject_id` | `uuid` | `scene`: the scene's entity ID; `reveal`: the revealed entity's ID |
| `visibility_mode`, `visibility_targets` | | `gm_only` or `everyone`, `[]`; `scene` and `status` are `everyone`, `reveal` is `gm_only` |
| `version` | `bigint not null default 1` | fixed at 1 |
| `created_at`, `created_by`, `updated_at`, `updated_by`, `deleted_at` | standard | immutable after insert |

All three tables are published to PowerSync and granted to `powersync_replicator`.

## Offline and Sync

- The device writes every change locally first, through feature 03 repositories. A session change and its log entry
  are two queued mutations, sent in order.
- The device shows a provisional number (`1 +` the highest it holds) until the accepted row arrives.
- Stream `authorized_sessions`: sessions for every member, GM notes for GM roles only (compiled `gm_only`), log
  entries by their own Visibility. A player replica never holds GM notes or a `gm_only` entry.
- A `scene` entry carries the scene's ID, never its name, so a hidden scene's name never reaches a player.

## Lifecycle, Export

- Sessions are records: no delete in P0. Campaign deletion removes them with the campaign's other rows.
- Exported by `SessionExporter` (`sessions`), with GM notes (export roles are GM roles). Restored to the importer:
  participants are mapped through `mapId('member', …)` and dropped when unmapped; a scene through
  `mapId('campaign_entity', …)`, cleared when unmapped. Both with a warning.

## Required Data Tests

CHECKs on status, end time, Visibility, kinds, and text bounds; the one-open-session index; GM notes and `gm_only`
entries absent from a player replica (simulated and live).

## Open Questions

None. See `_techspec.md`.
