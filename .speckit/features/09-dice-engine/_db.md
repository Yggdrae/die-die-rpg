# Data Design: Dice Rolls

Source: `_prd.md`, `_bdd.md`, `_techspec.md`, feature 04 `_db.md` (standard Visibility representation),
feature 03 `_db.md` (replica and queue), current migrations through `0013`.

## Data Inventory

| Data | Source of Truth | Storage | Offline | Sync | Conflict Strategy |
| --- | --- | --- | --- | --- | --- |
| Roll record | PostgreSQL `dice_rolls` | PostgreSQL + device SQLite replica | Yes, read and write | Compiled stream `authorized_rolls`; writes through `POST /sync/mutations` and the feature 09 applier | None: immutable; client-generated identity; an identity collision is refused |

No blob, CRDT, or WebSocket data. No audit row (D-08).

## Ownership and Access

| Data | Owner | Read | Write | Visibility |
| --- | --- | --- | --- | --- |
| `dice_rolls` | feature 09 | feature 04 decision on class `dice_roll`; features 06, 11, 15, 18, 19 through the feature 09 API | feature 09 applier, as the uploading actor, after two feature 04 decisions (D-12) | standard columns set at creation, never changed |

## Relational Changes

Forward-only migration `0014_dice_rolls`. Schema source `packages/dice/src/infra/postgres/schema.ts`, added
to `drizzle.config.ts`.

### `dice_rolls`

| Column | Type | Rule |
| --- | --- | --- |
| `id` | `uuid` | primary key; client-generated before queueing (exactly once) |
| `campaign_id` | `uuid not null` | no FK to `campaigns` (cross-feature table) |
| `actor_user_id` | `uuid not null` | the uploader; never from a claim |
| `actor_ref` | `text` | optional caller reference (a character), 1..128 |
| `target_ref` | `text` | optional caller reference, 1..128 |
| `action` | `text` | optional action key or label, 1..128 |
| `session_id` | `uuid` | optional; no FK (feature 18 does not exist yet) |
| `expression` | `text not null` | 1..200 characters |
| `inputs` | `jsonb not null default '{}'` | object: name to whole number |
| `result` | `jsonb not null` | object: the `RollResult` |
| `natural_result` | `integer not null` | equals `result.natural`, checked by replay |
| `modified_result` | `integer not null` | equals `result.modified`, checked by replay |
| `roll_visibility` | `text not null` | `public`, `gm_only`, `player_only`, `blind`, `whisper` |
| `visibility_mode` | `text not null` | feature 04 standard |
| `visibility_targets` | `jsonb not null default '[]'` | feature 04 standard |
| `version` | `bigint not null default 1` | always 1 |
| `rolled_at` | `timestamptz not null` | device time of the roll, kept for chronological logs |
| `created_at` | `timestamptz not null default now()` | authority time on accept |

`updatedAt`, `updatedBy`, `tags`, `metadata`, and `name` of the envelope are derived by the codec, not
stored: a roll never changes and has no labels of its own.

### Constraints and Indexes

- `dice_visibility_targets_valid(jsonb)`: sorted, unique, lowercase-UUID JSON array, per the feature 04
  template. Owned by this migration, so feature 16 can change its own without touching rolls.
- `dice_rolls_visibility_check` ties the label to the columns:
  `public` is `everyone` with `[]`; `gm_only` and `blind` are `gm_only` with `[]`; `player_only` is
  `players` with exactly `[actor]`; `whisper` is `players` containing `actor` and at least one other.
- `version = 1`; `expression` length; `jsonb_typeof` of `inputs` and `result` is `object`; ref and action
  lengths.
- Indexes: `(campaign_id, rolled_at DESC)`, and `(campaign_id, session_id, rolled_at)` where `session_id`
  is not null.

## Offline and Sync

- Local representation: replica table `dice_rolls` with the columns of `DICE_REPLICA_TABLES`, passed to the
  browser schema through `tables`. JSON arrives as text. `ROLL_ROW_CODEC` maps rows to `RollRecord`, and a
  row that does not map is `undefined`, never shown.
- Direction: server to client by the compiled stream; client to server only through the applier.
- Filter: compiled feature 04 predicate; the YAML query is guarded by the drift test. `gm_only` and `blind`
  rows are never in the result set of a player's query, so they never reach a player's replica.
- Publication: `ALTER PUBLICATION powersync ADD TABLE dice_rolls` and
  `GRANT SELECT ... TO powersync_replicator` in the migration. The sync service restarts after the YAML changes.
- Conflict: none (D-09, D-10). A terminal refusal leaves the queue's standard rejected state.
- Reconnect: queued rolls drain in causal order. A member demoted while offline: the authority refuses a
  hidden roll made before the change.
- Revocation: removal from the campaign removes rows from the replica through the standard purge, because
  `dice_rolls` is a feature table.

## Lifecycle, Retention, Export

- **Retention:** rolls live as long as the campaign. There is no per-roll delete (D-09) and no tombstone, so
  the stream has `deletedAtColumn: null`. Campaign deletion keeps its existing behaviour: replicas are
  purged by revocation, and physical purge of a deleted campaign's rows is not implemented platform-wide.
- **Local budget:** D-15, measured by a unit test.
- **Export:** module `dice_rolls`, deterministic order by id. See `_techspec.md` D-16.

## Migration and Backfill

New table, no backfill. Rollback is forward-only: remove the stream query and the policy in one change (the
drift gate keeps them equal); the table remains.

## Data Integrity Risks

- A label disagreeing with the Visibility columns: refused by the CHECK and by the service.
- A hidden row reaching a player: compiled predicate, drift gate, simulated replicas, live test, e2e.
- Replay cost on the hottest write path: bounded by the 100-dice limit.

## Required Data Tests

- CHECKs reject each inconsistent label and Visibility pair, a second version, invalid targets, an
  oversized expression.
- API and sync truth tables agree for `dice_roll`; PostgreSQL rendering agrees with `decide`.
- Player replicas contain no hidden roll; no checkpoint change under hidden churn.
- A retried and a resent roll leave one row.

## Open Questions

None. See `_techspec.md` "Decisions".
