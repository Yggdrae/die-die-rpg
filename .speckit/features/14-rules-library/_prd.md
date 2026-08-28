# PRD: Rules Library

Source: `PRD.md` s.9, s.14, s.26, s.27, s.68, s.69, s.76, s.78, s.87 Test 8, s.88.
Track: B. Depends on: the `rules` declaration in the manifest from feature 08.

## Problem

Rule lookup is the most common interruption at a table. Someone asks how healing works, and the
answer arrives from a PDF on someone phone, a memory that turns out to be wrong, or a browser
search that shows a different edition. `PRD.md` s.2 lists exactly this fragmentation as the
problem the product exists to solve, and s.78 sets the bar at under 10 seconds.

The complication is legal rather than technical. Mechanical support does not grant redistribution
rights (`PRD.md` s.9, s.14). The library must therefore work well when it holds the full text, and
work honestly when it can only point elsewhere.

## Goals

- A common rule is found in under 10 seconds, including during a session (`PRD.md` s.78).
- Lookup works offline for cached documentation (`PRD.md` s.87 Test 8).
- The library renders whatever a system package declares, with no system-specific code
  (`PRD.md` s.89).
- Where redistribution is not permitted, the interface says so plainly instead of appearing empty
  or broken.

## Non-Goals

- Authoring or editing rules text. Content comes from system packages (feature 08).
- Contextual rule suggestions driven by state (`PRD.md` s.27), deferred to V1.
- Redistributing text the licence does not permit (`PRD.md` s.14).
- Campaign house rules and GM notes. Feature 16 owns campaign content.
- A general-purpose wiki or document editor.
- Compendium browsing (creatures, equipment tables), which follows feature 08 FR-101.

## Users and Context

### Primary user

Any person at the table, mid-session, with the group waiting. This is the defining constraint:
the user is interrupted, impatient, and often on a phone. Depth of navigation is the enemy.

### Secondary users

A GM preparing between sessions, reading rather than searching, and a player learning a system
before session one.

## User Stories

- As a player, I want to search a rule by the word I would say out loud, so that I find it without
  knowing the book structure.
- As a GM, I want the rules available offline, so that a venue with no signal does not stop the
  table (`PRD.md` s.87 Test 8).
- As a GM, I want to bookmark the rules I keep needing, so that the third lookup is faster than the first.
- As a player, I want to follow a cross-reference, so that a rule that depends on another rule is
  one tap away (`PRD.md` s.26).
- As a GM, I want to see the rules of a system before selecting it, so that my choice is informed
  (`PRD.md` s.8).
- As a GM, I want to know when a system has no integrated text and where to look instead, so that
  I am not searching an empty library.

## Functional Requirements

### P0 — MVP

- FR-001: Structured document tree rendered from the system package `rules` declaration, following
  the shape in `PRD.md` s.26: introduction, character creation, core mechanics, combat, damage,
  healing, magic, equipment, GM procedures. The library renders the declared tree; it does not
  impose that outline.
- FR-002: Full-text search across the rules of the pinned system version, returning section
  matches with enough context to choose without opening each result.
- FR-003: Offline availability. Rules for a synchronized campaign are cached locally and searchable
  with no network (`PRD.md` s.76, s.87 Test 8).
- FR-004: Cross-references between sections, resolved and navigable (`PRD.md` s.26).
- FR-005: Bookmarks and favourites, per user per campaign (`PRD.md` s.26).
- FR-006: Recently viewed history (`PRD.md` s.26).
- FR-007: Quick rules: short summaries a package may declare for the sections asked about most,
  surfaced above full text in search results (`PRD.md` s.26).
- FR-008: Rules access from the system selection screen before a campaign exists, supporting
  feature 02 FR-002 (`PRD.md` s.8).
- FR-009: Player access to permitted rules per `PRD.md` s.69, subject to feature 04.
- FR-010: Honest empty state driven by the licence manifest and integration status
  (`PRD.md` s.9, s.14). When text cannot be redistributed, show the external documentation
  reference rather than an empty library.
- FR-011: Rules content is pinned to the campaign system version, so a lookup matches the rules in
  play (`PRD.md` s.66).
- FR-012: `SearchIndexer` implementation contributing rules to the global search in feature 20,
  so a GM does not have to choose which search to use.
- FR-013: Attribution required by the licence displayed with the content (`PRD.md` s.14).

### P1 — Important

- FR-101: Contextual rule suggestions from session state (`PRD.md` s.27, V1), which assist and
  never take narrative control.
- FR-102: In-session rules panel that does not leave Session Mode (`PRD.md` s.45).
- FR-103: Search across multiple installed systems, for a GM comparing systems.

### P2 — Later

- FR-201: Localized rules text per package (`PRD.md` s.14 translation status).
- FR-202: Compendium browsing alongside rules (feature 08 FR-101).

## Behavioral Constraints

- Read-only. The library never mutates rules content.
- No branch on system identity (`PRD.md` s.89). Structure comes from the package declaration.
- Content displayed must respect the licence manifest per asset class (`PRD.md` s.14). A package
  that forbids rules-text redistribution must not have text shipped or displayed.
- Search must work offline against the local cache. A search that silently degrades to fewer
  results when offline is worse than one that states its scope.
- The under-10-second target is measured from intent to answer, including navigation, not from
  query submission to response.
- Rules for the pinned version only. Showing a newer version silently would contradict `PRD.md` s.66.

## Data and Privacy Considerations

- Rules content is third-party licensed material. Redistribution is governed by the package
  licence manifest, and the library is where a violation would be visible to users.
- Bookmarks and history are per-user data scoped to a campaign and are not shared with the GM,
  because a player search history reveals intent.
- Cached rules occupy device storage and count toward the offline budget in `PRD.md` s.77.

## Success Signals

- `PRD.md` s.78 and s.87 Test 8: a common rule found in under 10 seconds, online and offline,
  measured with real users in the validation campaign.
- `PRD.md` s.88 acceptance: the GM consults integrated rules and searches a rule.
- Both MVP systems render with no library code naming either (`PRD.md` s.89).
- Zero rules text displayed for a package whose licence manifest forbids it.

## Rollout

Wave 4, Track B. Until the MVP packages ship, the library builds against the fixture rules tree
from feature 00, which is deliberately neither Cairn nor Fate so that structural assumptions stay
honest. Feature 02 links to the library from system selection when both are present, and degrades
to the external documentation reference before that.

## Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Rules text shipped without redistribution rights | Legal exposure, forced removal, damaged trust | Licence manifest gates display (FR-010, FR-013); features 12 and 13 verify rights before shipping text |
| Search is slow or shallow offline | The primary metric in `PRD.md` s.78 fails exactly when it matters most | Local index built at sync time; measured offline on a phone-class device, not only on a laptop |
| Navigation depth defeats the time budget | Users go back to a PDF and the feature is dead | Search-first interface, quick rules surfaced above full text (FR-007), in-session panel in P1 |
| Library imposes its own outline on packages | Systems with a different structure render awkwardly | Render the declared tree (FR-001); the `PRD.md` s.26 outline is an example, not a schema |
| Cached rules bloat device storage | Offline budget in `PRD.md` s.77 is consumed by text before attachments | Text is small relative to media; measure and include in the offline size estimate |

## ADR Candidates

None specific. The licence-gating approach belongs to feature 08 FR-003 and is applied here.

## Open Questions

- MVP rules text may ship only from the official Cairn and Fate SRDs under their applicable
  Creative Commons terms, with required attribution and share-alike compliance. Book content
  outside those SRDs is excluded.
- TODO: Search implementation for offline use, given the local database is SQLite/WASM
  (`PRD.md` s.53) and full-text search capability there needs verification.
- TODO: Whether player-permitted rules (`PRD.md` s.69) is a per-section visibility declaration in
  the package or a whole-library permission.
