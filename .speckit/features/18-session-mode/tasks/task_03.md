# Task 03: Export and import contributor

Status: completed (2026-11-04)

## Scope

- `SessionExporter` (`sessions`) with `ImportableModule`, registered in the export composition and the device export.

## Acceptance Criteria

- Sessions, GM notes, and entries round-trip to the importer. Unmapped participants and scenes are dropped with a
  warning.

## Verification

```bash
bun test apps/api/src/modules/portability apps/api/src/campaign-export.integration.test.ts apps/api/src/campaign-import.integration.test.ts
bun test apps/web/src/features/portability
```
