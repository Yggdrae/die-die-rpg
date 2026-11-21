# Task 04: Library screens, search contribution, shell

Status: completed (2026-11-06)

## Scope

- `apps/web/src/features/rules`: `rules-source.ts` (pin, package, marks over the replica), `RulesLibrary`
  (search-first, tree, section, quick rule, references, attribution, bookmarks, recent, states), `RulesPreview`,
  `rulesSearchContribution`, route `rules`.
- Replica table registered in `useBrowserSync`; `CampaignDashboard` mounts the library, lists the contribution, and
  offers the preview in the wizard (D-14).

## Acceptance Criteria

- Static markup: integrated, reference (each reason), empty, not installed; attribution always shown.
- The contribution is structurally a feature 20 `SearchContribution`; rules reach the palette through the shell.
- No feature imports another feature's internals.

## Verification

```bash
bun test apps/web/src/features/rules apps/web/src/features/campaigns
```

## Evidence (2026-11-06)

- `apps/web/src/features/rules`: `RulesLibrary.tsx` (`RulesView`, `RulesLibrary`, `RulesPreview`), `rules-source.ts`,
  `search-contribution.ts`, `index.ts`; `useBrowserSync` registers the replica table; `CampaignDashboard` mounts the
  library, lists `rulesSearchContribution`, and offers "Preview rules of <name>" outside the creation form.
- `rules.test.tsx`: 9 tests (search first, scope, tree, attribution, quick rule above text, references, results,
  reference reasons, forbidden text absent, empty, preview without marks, waiting, contribution, imports).
- `campaigns/search-composition.test.ts`: the contribution typed as `SearchContribution`, through the service and the
  palette provider, group "Rule".
