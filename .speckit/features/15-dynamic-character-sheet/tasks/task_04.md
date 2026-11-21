# Task 04: Audit, export, import, and search contributors

Status: completed (2026-11-03)

## Scope

- `character.created` and `character.deleted` audit declarations.
- `CharacterExporter` (module `characters`, chunk v1) online and over the browser replica; import writer; search
  indexer without GM-only values.

## Acceptance Criteria

- Export and import summaries list `characters`; an offline export over the replica is complete.

## Verification

```bash
bun test apps/api/src/campaign-export.integration.test.ts apps/api/src/campaign-import.integration.test.ts
bun test apps/web/src/features/portability apps/api/src/modules/audit apps/api/src/modules/portability
```
