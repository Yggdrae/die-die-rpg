# Task 01: Sheet model and edit plans

Status: completed (2026-11-03)

## Scope

- `@rpg/characters` `sheet.ts`: layout from the character schema, GM-only and declared paths, defaults, state split
  and merge, computed values, entries and items.
- Every sheet edit is a feature 11 plan on class `character`: numeric changes are merging deltas, text and slot sets
  are guarded by the value the device saw.
- `offline.ts`: the device repository shows an edit at once through the overlay.

## Acceptance Criteria

- Every declared field of the three installed packages renders once, with a component.
- Bounds hold; a player cannot plan a GM-only edit.
- The package names no system.

## Verification

```bash
bun test packages/characters
```
