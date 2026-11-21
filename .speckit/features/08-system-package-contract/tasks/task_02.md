# Task 02: Package schemas and plain-data guard

Status: completed (2026-10-30)

## Scope

- New workspace `packages/systems` (`@rpg/systems`), depending only on `@rpg/contracts` and TypeBox.
- `schema.ts`: `SystemPackage` and its blocks per the techspec "Package Shape".
- Move `SystemSummary`, `GameModeDeclaration`, `SystemOptionDeclaration`, `ModuleDeclaration`,
  `IntegrationStatus` here (re-exported by `@rpg/campaigns` in task 06).
- `plain-data.ts`: `assertPlainData` per the techspec, reading descriptors only.

## Acceptance Criteria

- BDD "Non-data values are refused" and "A package cannot pollute shared objects".
- An accessor's getter is never invoked (test counts calls).
- Unknown properties are refused at every level.
- A pool and a box track are both expressible; a track has no numeric `current` shape.

## Verification

```bash
bun test packages/systems
bun run typecheck
```
