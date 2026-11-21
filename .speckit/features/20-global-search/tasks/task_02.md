# Task 02: Contributors, visibility predicate, and routes

Status: completed (2026-11-06)

## Scope

- Feature 04: export pure `visibilityAdmits` (D-05).
- Feature 19: `EncounterSearchIndexer` (D-09).
- Web contributions: `characterSearchContribution`, `contentSearchContribution`, `encounterSearchContribution` (D-09).
- `apps/web/src/routes.ts`; content, characters, and encounters workspaces honour their route (D-10).

## Acceptance Criteria

- Each contribution's indexer reads only its feature's device source.
- An encounter document carries name and environment and the encounter's Visibility.
- A route link selects and shows the record in the owning view.

## Verification

```bash
bun test packages/encounters packages/authorization apps/web/src
```

## Evidence (2026-11-06)

- `visibilityAdmits` agrees with `decide` for every role and mode; party needs party IDs.
- `EncounterSearchIndexer` unit test. Contributions for characters, content, encounters; workspaces select the
  routed record (e2e: a result opens the content detail and the character sheet).
