# Task 02: Rules package: library model, search, marks

Status: completed (2026-11-06)

## Scope

- `packages/rules` (`@rpg/rules`): `rulesLibrary` (tree, states, reasons, displayed text, references, attribution;
  D-03, D-04, D-07), `RulesSearch` (D-06), `RulesSearchIndexer` and `rulesSearchDocs` (D-15).
- Marks: record schema and codec, derived ID (D-08), merge (D-09), policy (D-10), `RulesMarkLocalRepository` (D-11).

## Acceptance Criteria

- Forbidden text is never displayed even when present; the three states carry their reasons.
- Quick-rule matches come first and show the quick rule; the scope is stated.
- The merge never yields a conflict and is order-independent.
- No code names a system (guard).

## Verification

```bash
bun test packages/rules
```

## Evidence (2026-11-06)

- `packages/rules` (`@rpg/rules`): `library.ts`, `search.ts`, `records.ts`, `policies.ts`, `offline.ts`.
- `packages/rules/src/rules.test.ts`: 17 tests (tree order, states and reasons, forbidden text never shown, every
  shipped package an honest reference, text size budget, quick rules first, scope, feature 20 documents, derived ID,
  commutative merge, owner-only policy for every role, codec, device repository, no system named).
