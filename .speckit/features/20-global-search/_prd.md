# PRD: Global Search

Source: `PRD.md` s.26, s.45, s.68, s.76, s.78, s.88.
Track: C. Depends on: the `SearchIndexer` and `SearchDoc` registry contract from feature 00.
Every content-owning feature contributes its own indexer.

## Problem

`PRD.md` s.68 lists search as an MVP requirement without elaborating, and s.45 shows why it
matters: the command palette examples mix an NPC name, a rule, a clock, and an operation in one
input. A GM mid-session does not know or care which feature owns what they are looking for. They
know a word.

The dependency trap is the same one feature 07 faces. A search feature that knows how to index
characters, entities, handouts, sessions, and rules depends on five features and blocks on all of
them. Inverting the dependency removes the block and makes search complete automatically as
features land.

## Goals

- One search finds anything in a campaign the actor may see.
- Search works offline against the local database (`PRD.md` s.76).
- Results are fast enough for mid-session use, supporting the under-10-second rules budget and the
  command palette in `PRD.md` s.45.
- Search coverage grows as features land, with no change to this feature.

## Non-Goals

- The command palette itself. Feature 18 owns it and consumes this search.
- Rules-specific navigation, bookmarks, and cross-references. Feature 14 owns them.
- Cross-campaign or global-account search. Campaign-scoped only in MVP.
- Semantic or vector search, natural-language querying, and ranking sophistication beyond
  relevance basics.
- Search over attachment file contents, such as text inside a PDF.
- Saved searches and filters as a persistent user feature.

## Users and Context

### Primary user

The GM mid-session, who types two or three characters of a name and needs the right result at the
top. They are interrupted and will not scroll or refine a query.

### Secondary users

A GM preparing between sessions, browsing rather than seeking, and players looking up their own
content and revealed material.

## User Stories

- As a GM, I want to type a name and reach the NPC, so that I do not navigate a content list mid-session.
- As a GM, I want one search across content and rules, so that I do not choose where to look first
  (`PRD.md` s.45).
- As a GM, I want search to work with no signal, so that the venue network does not matter.
- As a player, I want to search my own content and what has been revealed, so that I can find a
  handout from three sessions ago.
- As a developer, I want to contribute my feature to search by registering an indexer, so that
  neither of us blocks the other.

## Functional Requirements

### P0 — MVP

- FR-001: `SearchIndexer` registry: each content-owning feature registers an indexer producing
  `SearchDoc` records with id, type, title, body, campaign, and visibility. This feature never
  reads another feature data model.
- FR-002: Local search index built from registered indexers, stored in the local database so
  search works offline (`PRD.md` s.76).
- FR-003: Campaign-scoped search across all registered types, returning ranked results grouped or
  labelled by type.
- FR-004: Visibility filtering. Results contain only what the actor may see, applied through
  feature 04 rather than by trusting the index.
- FR-005: Incremental index updates when content changes, including changes arriving through sync,
  so a newly synchronized NPC is findable without a rebuild.
- FR-006: Result navigation to the owning feature view, through a route the owning feature declares.
- FR-007: Prefix and partial-word matching, since a GM types three letters of a name rather than
  a complete one.
- FR-008: A published module API consumed by the command palette in feature 18 FR-009, so the
  palette does not implement its own search.
- FR-009: Index rebuild from scratch, for recovery and for a campaign that has just synchronized.

### P1 — Important

- FR-101: Type filters and scoping in the query.
- FR-102: Recent and frequent results surfaced before a query is typed.
- FR-103: Tag-aware search, using tags from feature 16.

### P2 — Later

- FR-201: Cross-campaign search.
- FR-202: Search inside attachment documents.
- FR-203: Fuzzy matching and typo tolerance.

## Behavioral Constraints

- This feature contains no knowledge of characters, entities, handouts, sessions, or rules. A type
  from another feature appearing here is a design failure, and it is the same rule feature 07 follows.
- Visibility is applied at query time against current permissions, not baked into the index at
  build time, because a reveal changes what a player may see without changing the content
  (feature 17).
- The index is derived and disposable. Losing it costs a rebuild and never data.
- Search must work offline with the same results as online for synchronized content. A silent
  reduction in scope when offline is worse than a stated one.
- Index maintenance must not degrade the cold-start budget in `PRD.md` s.79 or the write path in
  feature 03. Indexing is incremental and off the interaction path.
- An unavailable index degrades to a slower direct query rather than to no search at all.

## Data and Privacy Considerations

- The index contains GM-only content on a GM device and must never be built from content the
  device is not entitled to hold, which follows automatically from feature 03 sync rules but must
  be asserted rather than assumed.
- A result count or a highlighted snippet must not reveal the existence of hidden content
  (feature 04 constraint on inference).
- Index size counts toward the local database budget shared with feature 03.

## Success Signals

- `PRD.md` s.88 acceptance: the GM searches a rule and finds campaign content.
- A GM finds a known NPC in under 5 seconds from anywhere in the application, offline.
- Rules search through this feature meets the under-10-second budget in `PRD.md` s.78 and s.87 Test 8.
- Adding a new content feature requires zero changes here to become searchable.
- Zero hidden content appearing in results or inferable from result counts.

## Rollout

Wave 4, Track C, deliberately late. The registry contract is frozen in wave 0, so features
implement their indexer while they build. Feature 18 command palette ships before this feature and
uses a direct entity lookup until the search API is available, then switches to it. Nothing blocks
either way.

## Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Search implemented with knowledge of each feature model | This feature blocks on five others, and the split fails inside Track C | `SearchIndexer` registry (FR-001); architecture guard from feature 00 FR-009 |
| Visibility baked into the index | Stale permissions expose content after a reveal is withdrawn, or hide it after a reveal | Query-time filtering through feature 04 (FR-004) |
| Offline full-text search not available in SQLite/WASM as configured | The central offline promise fails for search specifically | Verify the capability during feature 03 wave 0 spike; a simpler prefix index is an acceptable MVP fallback |
| Index maintenance slows writes or cold start | Regression against the `PRD.md` s.79 budget on the screen it protects | Incremental, off the interaction path (constraint); measured with feature 18 |
| Palette and search implement two different lookups | Inconsistent results between the palette and the search screen, confusing mid-session | Palette consumes this API (FR-008) |

## ADR Candidates

None specific. Registry-based contribution shares its rationale with feature 07 and can be
recorded once for both.

## Open Questions

- TODO: Full-text search capability in SQLite/WASM under the chosen build. Shared with the
  feature 14 open question and worth answering once, in the feature 00 spike, since both features
  depend on it.
- TODO: Whether the index lives in the same local database as domain data or a separate store.
- TODO: Ranking approach across types, given a rule section and an NPC are not comparable by length
  or structure.
- TODO: Whether players get search in MVP or only GMs. `PRD.md` s.69 does not list it in the
  player scope.
