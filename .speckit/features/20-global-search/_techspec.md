# TechSpec: Global Search

Source: `_prd.md`, `_bdd.md`, `PRD.md` s.26, s.45, s.68, s.76, s.78, s.79; features 00, 03, 04, 15, 16, 17, 18, 19.
P0 only.

## Current Facts

- `SearchIndexer { moduleId; index(campaignId): Promise<SearchDoc[]> }` and `SearchDoc` (id, type, title, body,
  campaignId, visibility) are frozen in `@rpg/contracts` (`registries.ts`).
- `CharacterSearchIndexer` (feature 15) and `ContentSearchIndexer` (feature 16) exist and read through a narrow
  `list` source, so they run unchanged over the device replica.
- Feature 00 spike: FTS5 in SQLite/WASM is GO (5000 documents indexed in 101 ms, prefix query 0.5 ms).
- The web app reads every feature's data from the PowerSync replica; each device source exposes `subscribe` over the
  tables it reads. The replica holds only what the sync rules (feature 04) let the device hold.
- Feature 18 D-12: the palette matches its own entries and does a direct entity lookup until feature 20 contributes
  a provider through the shell. Its unit test forbids imports of contributing web features.
- Feature 04 decides reads with `AuthorizationService`; the Visibility part of that decision is a pure predicate.

## Decisions (open PRD questions closed; delegated by the owner, 2026-11-06)

- **D-01 Package `@rpg/search`.** Pure TypeScript: text normalization, the index, ranking, snippets. It imports
  `@rpg/contracts` only (guard rule `no-search-feature-imports`) and names no other feature's type. The screens,
  the device service, and the shell adapters live in `apps/web/src/features/search`.
- **D-02 The index lives in memory, built from the local database (open question 2).** The source of every document
  is the device replica, so search is offline by construction (FR-002) and online and offline results are the same:
  there is only one path. The index itself is a derived structure held per open campaign and never persisted:
  persisting it would add a local schema PowerSync does not own, a migration, and cold-start reads, while rebuilding
  costs milliseconds at campaign scale. Index size does not count toward the 60 MB local budget. FTS5 stays
  available to feature 14 if rules text needs it.
- **D-03 Matching (FR-007).** Text is lowercased and stripped of diacritics (NFD); words are runs of letters and
  digits. A query matches a document when every query word is a prefix of some word of its title or body (AND).
  An inverted index over a sorted vocabulary answers each word's prefix range by binary search.
- **D-04 Ranking (open question 3).** Type-agnostic: per query word, an exact title word scores 8, a title prefix 4,
  a body prefix 1; a title that starts with the whole query adds 4. Ties break by shorter title, then title, then id.
  A rule section and an NPC compete only on where the words matched, never on their type or length of body.
- **D-05 Visibility at query time (FR-004).** Each document keeps its stored Visibility. A query takes an `admits`
  predicate and drops every document it refuses before ranking, counting, and limiting, so counts and snippets
  never reveal hidden content. The device builds `admits` from feature 04's new pure `visibilityAdmits(actor,
  visibility)` (the predicate `AuthorizationService.decide` already applies) and the device's cached membership;
  no membership admits nothing.
- **D-06 The index holds only what the device holds.** Contributors read the replica only. On ingest a document must
  pass `check(SearchDoc)` and carry the open campaign's ID; anything else is dropped and counted per module.
- **D-07 Incremental by module (FR-005, FR-009).** A contribution pairs an indexer with the owning source's
  `subscribe`. A change re-runs that module's indexer after the change settles and replaces its documents (diffed by
  ID); a run requested while one is in flight runs once more after it. Rebuild runs every contributor again. The
  contract stays frozen: no per-document API is needed.
- **D-08 Off the interaction path.** The first build starts on an idle callback (fallback 50 ms), never during the
  first render, so Session Mode's cold-start budget (feature 18 D-16) is untouched. Until it ends, the screen says
  "Indexing…" rather than showing a silent subset; a failed module is named ("Could not index: …").
- **D-09 Contributions (FR-001).** Each owning web feature exports a `…SearchContribution(source)` returning
  `{ indexer, subscribe, typeLabel, route }`, structurally matching feature 20's `SearchContribution`; neither side
  imports the other. The shell (`CampaignDashboard`) lists them. P0 contributors: characters (15), content entities
  including handouts and scenes (16, 17), encounters (19, new `EncounterSearchIndexer`: name and environment,
  `everyone`). Sessions contribute nothing in P0: their only text is per-entry log text with per-entry Visibility,
  read on the session screen. Rules arrive with feature 14.
- **D-10 Navigation (FR-006).** A contribution declares `route(doc)`: a hash route `#/<area>/<id>` built with the
  app-level `routes.ts`. Results are links. The owning workspace listens with `useRouteTarget('<area>')`, selects the
  record, and scrolls it into view. Content owns `content`, characters `characters`, encounters `encounters`.
- **D-11 Module API (FR-008).** `SearchService` (`createSearchService`) exposes `query(text, { limit })`, `subscribe`,
  `status`, and `rebuild`; the screen and the palette consume the same service, so their results agree.
- **D-12 Palette provider (feature 18).** Feature 18 gains a local `PaletteProvider { id; entries(query) }` and an
  optional `paletteProviders` prop. With a provider, Session Mode drops its direct entity lookup (scenes stay its
  own); a provided entry that names an entity the session holds opens the lookup panel, any other runs its `open`.
  The shell adapts the search service into a provider (`searchPaletteProvider`). Feature 18 imports nothing of 20.
- **D-13 Players get search (open question 4).** Same screen, same index; the replica and D-05 keep it to their own
  content and what is revealed (`_prd.md` user story).
- **D-14 Snippet.** Up to 120 characters of the document's own body around the first body match, on word bounds;
  no snippet when only the title matched.
- **D-15 Limits.** The screen shows up to 20 results and the total count; the palette adds up to 8 provided entries
  after its own matches. Queries shorter than one character return nothing.
- **D-16 No system identity, no type literals.** Ranking, labels, and routes never branch on a type or a system;
  labels come from the owning feature (`typeLabel`).

## Design

```text
owning web feature --(…SearchContribution: SearchIndexer + subscribe + route + typeLabel)--> shell
shell --(contributions, campaignId, admits)--> createSearchService (apps/web/src/features/search)
search service --> SearchIndex (@rpg/search) <-- query(text, admits)
SearchWorkspace <-- service --> searchPaletteProvider (shell) --> SessionWorkspace.paletteProviders
```

- `packages/search/src/text.ts`: `normalizeText`, `words`.
- `packages/search/src/search-index.ts`: `SearchIndex` (`replaceModule`, `removeModule`, `clear`, `query`,
  `moduleSize`), `SearchHit` (`doc`, `score`, `snippet`), `SearchResults` (`hits`, `total`).
- `apps/web/src/features/search/search-service.ts`: `createSearchService({ campaignId, contributions, actor })`.
- `apps/web/src/features/search/SearchWorkspace.tsx`: the campaign search (`<search>` landmark).
- `apps/web/src/routes.ts`: `routeHref(area, id)`, `useRouteTarget(area)`.
- Shell: `apps/web/src/features/campaigns/search-composition.ts` (`searchPaletteProvider`, `deviceSearchActor`).

## Changes in Other Features

- Feature 04: export `visibilityAdmits(actor, visibility, partyIds?)` (pure, used by `decide`).
- Feature 15 web: `characterSearchContribution`; `CharacterWorkspace` honours route `characters`.
- Feature 16 web: `contentSearchContribution`; `ContentWorkspace` honours route `content`.
- Feature 19: `EncounterSearchIndexer` in `@rpg/encounters`; web `encounterSearchContribution`;
  `EncounterWorkspace` honours route `encounters`.
- Feature 18: `PaletteProvider`, `paletteProviders` prop, lookups from providers.
- Feature 00 guard: rule `no-search-feature-imports`.

## Testing

- `packages/search`: normalization, prefix AND matching, ranking, visibility before count, snippet, replace and
  remove, invalid and foreign-campaign documents dropped, no feature type literal.
- `apps/web/src/features/search`: service (build, incremental replace on change, coalescing, failure stated,
  rebuild equals incremental, reveal admits at query time), screen markup, architecture (imports).
- Feature 18 unit: provided entries replace direct lookups; Session Mode still imports none of 16, 17, 19, 20.
- `EncounterSearchIndexer` unit test.
- `apps/web/e2e/search.e2e.ts` (real stack): GM finds a GM-only NPC in under 5 seconds and opens it; player finds
  only what they may see, count 0 for hidden; a synchronized location appears on the player's open search; offline
  create is findable; palette shows search results.

## Risks

| Risk | Mitigation |
| --- | --- |
| Re-indexing a large module on every write | Throttled `subscribe` (50 ms), coalesced runs, off the render path |
| A contributor leaks GM-only text in an `everyone` document | Contributors index only fields with the document's Visibility (encounter: name and environment; character: public state) |
| Hash routes collide with future routing | Areas are owned per feature; `routes.ts` is the one place to replace |
