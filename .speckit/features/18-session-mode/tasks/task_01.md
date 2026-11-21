# Task 01: Records, model, policies, and persistence

Status: completed (2026-11-04)

## Scope

- `packages/sessions`: records and replica codecs for sessions, GM notes, and log entries; the pure model (`domain.ts`:
  transitions, provisional number, scene context, log merge, palette matching); Resource Policies; audit declarations.
- Device repositories over feature 03 `SyncedRepository`.
- Schema and migration `0017_sessions` (`_db.md`). Feature 15 `characterSummary` (additive).

## Acceptance Criteria

- Invalid transitions, a second open session, and out-of-bound text are refused on the device before anything is
  queued, and by the database.
- Scene context resolves location and NPCs from feature 16 rows only when present.
- Summaries render for the fixture, Cairn 2e, and Fate Core packages from declarations only.

## Verification

```bash
bun run db:migrate
bun test packages/sessions packages/characters
```
