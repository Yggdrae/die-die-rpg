# Task 01: Records, model, policies, and persistence

Status: completed (2026-11-06)

## Scope

- `packages/encounters`: records and replica codecs for encounters, GM notes, participants, and instance states; the
  pure model (`domain.ts`: labels, public split, initial instance state, controls, change rules); Resource Policies;
  audit declarations; device repositories over feature 03 `SyncedRepository`.
- Schema and migration `0018_encounters` (`_db.md`). Feature 16 type constants (additive).

## Acceptance Criteria

- An ended encounter, an invalid change, and out-of-bound text are refused on the device before anything is queued,
  and by the database.
- Labels number instances; three instances of one entity have three states.
- Controls and summaries come from declarations for the fixture, Cairn 2e, and Fate Core packages.

## Verification

```bash
bun run db:migrate
bun test packages/encounters
```
