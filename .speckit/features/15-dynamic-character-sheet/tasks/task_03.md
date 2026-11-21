# Task 03: Authority service, applier, and effect target

Status: completed (2026-11-03)

## Scope

- `CharacterService` create and delete, pinned to the campaign system, from defaults only.
- `CharacterSyncMutationApplier` and `characterTargetAdapter`: edits arrive as feature 11 applications; saves split
  by path; undeclared and (for players) GM-only paths are denied; values are clamped to the schema.
- Composition in `apps/api/src/runtime.ts`.

## Acceptance Criteria

- Concurrent numeric changes merge; concurrent text edits refuse instead of overwriting.
- Another player can neither edit nor see a character; a GM-only value reaches no player.

## Verification

```bash
bun test apps/api/src/modules/characters
```
