# Data Design: Handouts and Reveal

Source: `_prd.md`, `_bdd.md`, `_techspec.md`, feature 04, 05, and 16 data designs.

## Data Inventory

| Data | Source of Truth | Storage | Offline | Sync | Conflict Strategy |
| --- | --- | --- | --- | --- | --- |
| Handout | PostgreSQL `content_entities`, `type = 'handout'` | PostgreSQL + permitted replicas | Read (recipients), write (GM roles) | Feature 16 `authorized_content` stream | Feature 16: versioned, long-text hold for the body |
| Recipients | `content_entities.visibility_mode`, `visibility_targets` | Same row | Same | Same | A reveal names the version it was decided on; a mismatch refuses |
| Handout attachments | PostgreSQL `attachments`, owner `campaign_entity` | PostgreSQL + object storage | Feature 05 offline set | Not replicated to players; read grants per request | Feature 05 |
| Reveal history | Feature 06 `visibility.revealed` / `visibility.unrevealed` | Audit stores | Feature 06 | Feature 06 | Append-only |

## Relational Changes

None. A handout is a feature 16 entity type (`_techspec.md` D-01). No migration.

## Write Paths

- Create, edit, delete: feature 16 entity mutations.
- Reveal and un-reveal: a feature 16 entity `update` mutation carrying `visibilityChange` and no audit envelope. The
  applier hands it to feature 04 `VisibilityService.change` with the mutation ID as the audit origin, so the visibility
  write, the version bump, and the audit event commit together, and a retried upload records one event.
- Attachments on a handout are uploaded with their own Visibility `everyone`. The effective read is the handout's
  decision intersected with it (feature 05), so it equals the handout's audience as it changes.

## Privacy

- A hidden handout is filtered by the feature 16 stream predicate. Nothing about it reaches a non-recipient device.
- Recipients' IDs are stored in the row and the audit payload. Audit text renders a count, not names.
- Export carries handouts with their visibility (feature 16 contributor). Import narrows unknown targets to `gm_only`.
