# Contract change: quick rules on a rules section

Date: 2026-11-06. Feature 14 task 01.

## Reason

Feature 14 FR-007 needs short summaries a package may declare for the sections asked about most. The rules
declaration had no place for them.

## Surface

- `RulesDeclaration.sections[]` gains optional `summary` (1 to 500 characters), in `packages/systems/src/schema.ts`.
- A summary is rules text: `integrated_rules` evidence and the licence check count a section with a summary or a body.

## Affected features

Feature 14 (consumer). Features 12 and 13 ship no text and declare no summary. The fixture package declares some.

## Migration

None. The field is optional; stored data holds no package content.

## Review

Ratified 2026-11-06 (A/B/C, repository owner delegation).
