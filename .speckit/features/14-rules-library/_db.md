# Data Design: Rules Library

Source: `_prd.md`, `_bdd.md`, `_techspec.md`, features 03, 04, 08, 16 data designs, migrations through `0018`.

## Data Inventory

| Data | Source of Truth | Storage | Offline | Sync | Conflict Strategy |
| --- | --- | --- | --- | --- | --- |
| Rules text, tree, quick rules | The pinned system package (feature 08) | Application bundle | Whenever the app is | None (bundled) | None (read-only, immutable per version) |
| Section mark (bookmark, last viewed) | PostgreSQL `rules_section_marks` | PostgreSQL + the owner's replica | Read and write (owner) | Stream `authorized_rules_marks` | Merged by the authority, never a conflict (D-09) |
| Search index | Derived | Memory | Yes | None | Rebuilt |

## Relational Changes

Migration `0019_rules_section_marks`. Schema `packages/rules/src/infra/postgres/schema.ts`. No foreign keys to other
features' tables.

### `rules_section_marks`

| Column | Type | Rule |
| --- | --- | --- |
| `id` | `uuid` | primary key, derived from (campaign, user, section) (D-08) |
| `campaign_id` | `uuid not null` | |
| `user_id` | `uuid not null` | the owner; Ownership Rule column |
| `section_id` | `text not null` | 1 to 64 characters, a section of the pinned package at write time |
| `bookmarked` | `boolean not null` | |
| `bookmark_changed_at` | `timestamptz` | set exactly when the bookmark was ever changed |
| `viewed_at` | `timestamptz` | last view |
| `visibility_mode`, `visibility_targets` | as feature 04 | fixed `players`, `[user_id]` |
| `version`, `created_at`, `updated_at`, `created_by`, `updated_by`, `deleted_at` | standard | no delete in P0 |

Unique `(campaign_id, user_id, section_id)`. CHECKs: section length, `bookmarked` implies `bookmark_changed_at`, a row
is a bookmark or a view (`bookmark_changed_at` or `viewed_at` present), fixed Visibility, version `>= 1`.

Published to PowerSync and granted to `powersync_replicator`.

## Offline and Sync

- Every change is local first through a feature 03 repository and waits in the queue offline.
- Stream `authorized_rules_marks`: the requester's own rows, for every member role; compiled from the policy.
- Retention: one row per section per user per campaign, bounded by the package's sections. Campaign deletion removes
  them with the campaign's other rows; revocation purges them from the device with the campaign replica.

## Lifecycle, Export

- Not exported and not imported (D-10): private navigation aids, like feature 16 personal notes.
- Not audited (D-10).

## Required Data Tests

CHECKs; another user's rows absent from a replica (compiled predicate); a merge that never reports a conflict; a
derived-ID mismatch and an undeclared section refused.

## Open Questions

None. See `_techspec.md`.
