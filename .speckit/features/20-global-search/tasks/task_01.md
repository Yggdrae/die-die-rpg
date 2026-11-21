# Task 01: Search package and guard rule

Status: completed (2026-11-06)

## Scope

- `packages/search` (`@rpg/search`): `normalizeText`, `words`, `SearchIndex` (D-01, D-03, D-04, D-05, D-06, D-14).
- Guard rule `no-search-feature-imports`: `packages/search` imports `@rpg/contracts` only; the web search feature
  imports `@rpg/contracts`, `@rpg/search`, `@rpg/authorization`, and no other feature folder.

## Acceptance Criteria

- Prefix AND matching across title and body, accent- and case-insensitive.
- Type-agnostic ranking (title before body), deterministic ties.
- A refused document never counts, ranks, or contributes a snippet.
- Invalid or foreign-campaign documents are dropped and counted per module.
- The guard rule fails on a violating fixture.

## Verification

```bash
bun test packages/search tools/guard
```

## Evidence (2026-11-06)

- `packages/search`: 11 tests (normalization, prefix AND, accents, ranking, visibility before count and limit,
  snippets, diff by ID, modules, invalid and foreign documents dropped, 5000 documents, imports and type names).
- Guard rule `no-search-feature-imports` fails on violating fixtures (`tools/guard/src/rules.test.ts`).
