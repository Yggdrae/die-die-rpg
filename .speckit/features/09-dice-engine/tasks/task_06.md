# Task 06: Export and import

Status: completed (2026-10-31)

## Scope

- `RollExporter` (D-16), import writer, composition registration, offline gap.

## Acceptance Criteria

- Round trip restores results; unmapped targets narrow with a warning; two reads are byte-identical.

## Verification

```bash
bun test packages/dice apps/api/src/modules/portability apps/api/src/campaign-import.integration.test.ts
```
