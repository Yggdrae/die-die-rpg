# Task 03: Export and import contributor

Status: completed (2026-11-06)

## Scope

- `EncounterExporter` (`encounters`) in the server and device exports, with the import writer.

## Acceptance Criteria

- Export and import restore encounters, notes, participants, and instance states, mapped as `_db.md` says, with a
  warning per cleared link or dropped participant.

## Verification

```bash
bun test apps/api/src/modules/portability apps/api/src/campaign-export.integration.test.ts apps/web/src/features/portability
```
