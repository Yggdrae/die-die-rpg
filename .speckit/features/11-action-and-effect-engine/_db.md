# Data Design: Effect Applications

Source: `_prd.md`, `_bdd.md`, `_techspec.md`, feature 04 `_db.md`, feature 03 `_db.md`, migrations through `0014`.

## Data Inventory

| Data | Source of Truth | Storage | Offline | Sync | Conflict Strategy |
| --- | --- | --- | --- | --- | --- |
| Effect application | PostgreSQL `effect_applications` | PostgreSQL + device SQLite replica | Yes, read and write | Compiled stream `authorized_effects`; writes through `POST /sync/mutations` and the feature 11 applier | Semantic merge on the target; guards refuse; immutable record; client-generated identity |
| Target state | The target's owner (feature 15, later 19) | The owner's table | The owner's | The owner's | Written only through `EffectTargetAdapter` |

No blob, CRDT, or WebSocket data.

## Ownership and Access

| Data | Owner | Read | Write | Visibility |
| --- | --- | --- | --- | --- |
| `effect_applications` | feature 11 | feature 04 decision on class `effect_application`; feature 18 through the feature 11 API | the applier as the uploader, after feature 04 decisions on the class and on the target | set by the authority from the target; never changed |

## Relational Changes

Forward-only migration `0015_effect_applications`. Schema source `packages/actions/src/infra/postgres/schema.ts`.

### `effect_applications`

| Column | Type | Rule |
| --- | --- | --- |
| `id` | `uuid` | primary key; client-generated before queueing; the idempotency key (FR-012) |
| `campaign_id` | `uuid not null` | no FK (cross-feature) |
| `actor_user_id` | `uuid not null` | the uploader |
| `target_class` | `text not null` | a Resource Class token |
| `target_id` | `uuid not null` | no FK: the owner's table varies by class |
| `action` | `text` | optional action key, 1..128 |
| `outcome` | `text` | optional outcome id, 1..128 |
| `roll_id` | `uuid` | optional feature 09 roll; no FK |
| `session_id` | `uuid` | optional; no FK |
| `operations` | `jsonb not null` | array of planned operations, 1..64 |
| `changes` | `jsonb not null default '[]'` | array of `{ path, before, after }`, authority-computed |
| `edited` | `boolean not null default false` | needs `override` |
| `visibility_mode`, `visibility_targets` | as feature 04 | authority-set |
| `version` | `bigint not null default 1` | always 1 |
| `applied_at` | `timestamptz not null` | device time |
| `accepted_at` | `timestamptz not null default now()` | authority time |

`effect_visibility_targets_valid(jsonb)` is owned by this migration. CHECKs: `version = 1`, Visibility mode and
targets, `operations` array length, `changes` is an array, token and length rules. Indexes:
`(campaign_id, target_class, target_id, applied_at)`, and `(campaign_id, session_id, applied_at)` where a session exists.

## Offline and Sync

- Local representation: replica table `effect_applications`. On the device, `accepted_at` is null until the authority's
  row replaces the optimistic one. The overlay applies only rows with no `accepted_at` (D-11).
- The accepted row and the owner's new state arrive in one provider checkpoint, so display never double-counts.
- Direction: server to client by the compiled stream; client to server only through the applier.
- Publication: `ALTER PUBLICATION powersync ADD TABLE` and `GRANT SELECT` in the migration.
- Reconnect: queued applications drain in causal order. A refusal stays as a rejected mutation, counted and reported by
  the feature 03 surface. The overlay stops applying a rejected record.
- Revocation: the standard purge, since it is a feature table.

## Lifecycle, Retention, Export

- Records live as long as the campaign, with no delete and no tombstone (`deletedAtColumn: null`).
- Not exported (D-18), like the audit log. `BROWSER_REPLICA` export coverage does not name it.
- Budget: application rows are about the size of a roll and far fewer. The allowance is shared from the campaign's
  60 MB. Feature 18 measures it with the validation campaign alongside rolls.

## Migration and Backfill

New table, no backfill. Forward-only.

## Data Integrity Risks

- Target changed without a record, or the reverse: one transaction, on one database, by the adapter contract.
- A replay doubling a change: the identity is claimed first, inside the transaction.
- A record wider than its target: the authority sets Visibility, and tests assert players' replicas.

## Required Data Tests

- CHECKs reject a second version, invalid targets, an empty operation list.
- Merge in both orders; replay and resend leave one record and one change.
- A fault after the claim leaves neither record nor change.
- Player replicas hold no record for a hidden target.

## Open Questions

None. See `_techspec.md` "Decisions".
