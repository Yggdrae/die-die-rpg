# Task 05: Sheet, actions, and workspace screens

Status: completed (2026-11-03)

## Scope

- `SheetView`, `ActionPanel` (`PlanView`), `CharacterWorkspace`, and `browserCharacterSource` over the replica.
- Mounted on the campaign dashboard; replica tables registered in `useBrowserSync`.

## Acceptance Criteria

- Each installed package renders every field; an unbuilt component degrades visibly.
- A plan shows its outcome and each change before it applies.
- No character screen names a system.

## Verification

```bash
bun test apps/web/src/features/characters
```
