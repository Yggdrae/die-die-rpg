# Task 03: Search service, screen, and palette provider

Status: completed (2026-11-06)

## Scope

- `createSearchService` (D-07, D-08, D-11), `SearchWorkspace` (D-08, D-15), shell composition in
  `CampaignDashboard` with `searchPaletteProvider` and the device actor (D-05, D-12, D-13).
- Feature 18: `PaletteProvider`, `paletteProviders`, lookups from providers (D-12).

## Acceptance Criteria

- Incremental replace per module on change; coalesced runs; rebuild equals incremental.
- A failing module is named; "Indexing…" until the first build ends.
- A reveal admits the document at the next query without a rebuild.
- The palette lists search results and opens the lookup panel for held entities; Session Mode imports nothing of 20.

## Verification

```bash
bun test apps/web/src/features/search apps/web/src/features/sessions
```

## Evidence (2026-11-06)

- `apps/web/src/features/search/search.test.tsx`: build, incremental per module, coalescing, reveal admitted at the
  next query, no membership admits nothing, failure named, rejected counted, rebuild equals incremental, scheduler,
  screen markup, imports. `sessions.test.tsx`: provider replaces lookups; Session Mode imports none of 16, 17, 19, 20.
  `search-composition.test.ts`: palette provider equals the screen's results.
