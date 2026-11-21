# TechSpec: Rules Library

Source: `_prd.md`, `_bdd.md`, `_db.md`, `PRD.md` s.8, s.9, s.14, s.26, s.45, s.66, s.69, s.76, s.78, s.87 Test 8,
s.88, s.89; features 03, 04, 08, 12, 13, 18, 20. P0 only.

## Current Facts

- Feature 08 declares `rules.sections[]` (`id`, `title`, `category`, optional `body`, `references`) and the licence
  manifest (`assets.rulesText`). Load refuses a package whose shipped text contradicts its licence or its
  `rulesTextIntegrated` flag, and a reference to an undeclared section. Capability `integrated_rules` is claimed
  exactly when a section ships text.
- Features 12 and 13 ship section trees with no text (`rulesTextIntegrated: false`, external documentation). The
  fixture package declared no sections; `FIXTURE_RULES` in `@rpg/fixtures` had a nested shape no contract accepts.
- The browser loads every installed package (the fixture included) from the application bundle through
  `createInstalledRegistry`, and resolves a campaign's pin from the replicated `campaign_system_pins`.
- Feature 20 hosts device search: `SearchContribution { indexer, subscribe, typeLabel, route }`, listed by the shell
  (`CampaignDashboard`). Session Mode's palette searches through it. Routes are `#/<area>/<id>` (`routes.ts`).
- Feature 16's `personal_note` is the precedent for author-private rows: an Ownership Rule on every capability, no
  exempt role, fixed Visibility `players:[author]`, never exported, not audited.

## Decisions (open PRD questions closed; delegated by the owner, 2026-11-06)

- **D-01 Package `@rpg/rules`.** Root (pure): the library model, the search over a package's rules, the marks records,
  policy, codec, and device repository. `/postgres`: schema, repository, service. The applier lives in
  `apps/api/src/modules/rules`, the screens in `apps/web/src/features/rules`.
- **D-02 Text comes from the pinned package in the application bundle (FR-003, open question 1).** Rules text is
  package content, identical for every member, so it is not synchronized or stored by this feature: it ships with the
  installed packages in the bundle the PWA caches, and is available offline whenever the app is. Search is an
  in-memory `@rpg/search` index built from the package's sections when the library opens. FTS5 is not needed (same
  reasoning as feature 20 D-02). Text is small next to attachments: the installed packages' rules text is measured by
  a unit test (under 256 KiB in total).
- **D-03 The declared tree (FR-001).** Sections are grouped by `category` in first-appearance order and listed in
  declared order. A heading is the category key humanized (`core_mechanics` → "Core mechanics"). No outline is
  imposed and no category is required.
- **D-04 Licence gating, twice (FR-010, FR-013).** Text (body and quick rule) is displayed only when
  `license.assets.rulesText` is exactly `allowed` and the section carries it; load already refuses contradictions and
  the library re-checks. The library state is `integrated` (some section shows text), `reference` (sections, no text),
  or `empty` (no sections). The reference reason comes from the licence: `forbidden` "The licence does not permit
  including this text", `review-required` "Including this text awaits licence review", `allowed` "This text is not
  included in the app yet". The external documentation link is shown whenever declared; a section without text in an
  integrated package links it too. Licence name, attribution, and source are always shown.
- **D-05 Quick rules (FR-007): additive contract change to feature 08.** A section may declare `summary` (at most 500
  characters). It is rules text: licence-gated like `body` and evidence for `integrated_rules`. It is shown above the
  section's full text, and a library search lists matching sections with a quick rule first, showing the quick rule
  instead of a snippet. Note: `00-platform-foundation/2026-11-06-rules-quick-summary-contract-change.md`.
- **D-06 Library search (FR-002).** Search-first screen: the search box is the first control. Prefix AND,
  accent-insensitive (`@rpg/search`) over title, quick rule, and body; title matches rank first. Each result shows its
  category and its quick rule or a snippet of its own text. The scope is stated: "N sections of <name> <version>, on
  this device". A reference-only package is searched by title and category.
- **D-07 Cross-references (FR-004).** Declared references are rendered as buttons naming the target section; one tap
  opens it. Load guarantees they resolve; an unresolved one is not rendered.
- **D-08 Marks: one row per (campaign, user, section) (FR-005, FR-006).** `_index.md` names `rules_bookmark` and
  `rules_history`; both are kept on one row of `rules_section_marks`, because each is one fact about one section for
  one user and one row keeps the replica, the stream, and the merge single. A bookmark is the favourite (`PRD.md` s.26
  lists both; one action in P0). The row ID is derived from (campaign, user, section) (SHA-256, UUID-shaped), so two
  devices address the same row and the authority refuses any other ID.
- **D-09 Marks never conflict.** An insert of an existing row and an update at a stale version are merged by the
  authority: the bookmark flag with the later `bookmark_changed_at`, `viewed_at` as the later of the two. The result
  is accepted with the stored version, so a device never sees a conflict for a navigation aid.
- **D-10 Privacy (`_prd.md` "Data and Privacy").** Class `rules_section_mark`: `read`, `create`, `update` for owner,
  GM, assistant GM, and player, an Ownership Rule (`authorUserId` = the row's `user_id`) on every capability with no
  exempt role, observer none, fixed Visibility `players:[user]`. Stream `authorized_rules_marks` holds only the
  requester's own rows. Not exported (private, like personal notes) and not audited (an audit event would show a
  player's lookups to the GM).
- **D-11 History (FR-006).** Opening a section (tree, search, reference, route) records `viewed_at`, at most once per
  section per 60 seconds per device. Recently viewed lists the 10 latest, newest first. Rows stay one per section, so
  storage is bounded by the package's section count; no trimming. Clearing history is deferred.
- **D-12 Every member reads every section (FR-009, open question 2).** Rules text is the package's, the same for every
  member, and already in every member's bundle, so a per-section Visibility would protect nothing. A per-section
  declaration waits for a package that needs one (contract change then).
- **D-13 Pinned version only (FR-011).** The library resolves the replicated pin through the installed registry. When
  the pinned version is not installed it says so ("The pinned rules, <system> <version>, are not installed in this
  version of the app") and shows nothing else. Before the pin arrives it says it is waiting for the campaign.
- **D-14 Before a campaign (FR-008).** Each system of the creation wizard keeps its external "Rules for <name>" link
  and gains a "Preview rules of <name>" button when its package is installed. It opens the same library for that
  package, without marks, and does not change the selection.
- **D-15 Global search (FR-012).** `RulesSearchIndexer` (module `rules`) indexes one document per section of the
  pinned package: type `rules_section`, title, body = quick rule and text when licence-allowed, else the category
  heading; Visibility `everyone` (D-12). The web feature exports `rulesSearchContribution(source)` (type label "Rule",
  route `#/rules/<section>`); the shell lists it. Session Mode's palette reaches it through the existing provider
  (feature 20 D-12); a rule entry follows its route. The library opens and scrolls to a routed section.
- **D-16 The 10 second budget is a test (owner rule).** Playwright measures from focusing the rules search to the
  section text being visible, online and offline, and asserts under 10,000 ms. Global search and the palette are
  asserted to reach the same section.
- **D-17 The fixture ships the fixture rules tree.** `FIXTURE_RULES` becomes a `rules` declaration of invented text
  (introduction, core mechanics, checks, harm, healing, equipment, GM procedures; quick rules and cross-references) in
  `FIXTURE_SYSTEM_PACKAGE`, with `rulesText: allowed` (invented, no external source), capability `integrated_rules`,
  and `rulesTextIntegrated: true`. Its version stays `0.1.0`: the fixture is never published. Features 12 and 13 keep
  exercising the reference state. No library code names a system (guard).
- **D-18 Deferred.** FR-101 to FR-103, FR-201, FR-202, clearing history.

## Resource Policies

| Class | owner / gm / assistant_gm / player | observer | Ownership | Visibility | Sync |
| --- | --- | --- | --- | --- | --- |
| `rules_section_mark` | read, create, update | none | every capability, no exempt role | fixed `players:[user]` | `rules_section_marks` |

## Authority

`RulesMarkService` (feature `rules`, applier for `rules_section_marks`):

- Insert or update: a valid mark of the actor's campaign, `user_id` = the actor, the derived ID, a section declared by
  the campaign's pinned package, timestamps not in the future. Re-decided through feature 04 (Ownership Rule).
- Merge per D-09 under a row lock; tombstones are refused (no delete in P0).
- Codes: `invalid_payload`, `invalid_rules_mark`, `not_found_or_forbidden` (terminal), `authority_unavailable`
  (retryable). Never `conflict`.

## Device

- `RulesMarkLocalRepository`: `list()`, `bookmark(section, on)`, `viewed(section)`; derived lists `bookmarks()` and
  `recent()`.
- Pure model (`library.ts`): `rulesLibrary(system)` (state, groups, sections, displayed text, references, attribution),
  `RulesSearch` (in-library search), `rulesSearchDocs` (feature 20 documents).
- Web: `RulesLibrary` (search, tree, section, bookmarks, recent), `RulesPreview` (wizard), `rules-source.ts` over the
  browser replica, `search-contribution.ts`.

## Test Strategy

- Unit: tree grouping, the three states and reasons, licence gating with forbidden text present, quick rules first,
  scope statement, references, search docs, marks merge, derived ID, device repository, rules text size, static
  markup of the screen.
- PostgreSQL: matrix (own rows only, observer none), derived ID and undeclared section refused, merge never conflicts,
  retry idempotent, CHECKs.
- Sync: stream compiled from the policy (drift-gated), publication allow-list, audit exclusion.
- E2E: under 10 seconds online and offline, cross-reference, bookmark and history, global search and palette, privacy
  between GM and player, offline bookmark reaching the authority.

## Changes in Other Features (additive)

- Feature 08: optional `summary` on a rules section; `integrated_rules` evidence counts it.
- Feature 00 fixtures: the fixture package ships the fixture rules tree (D-17).
- Feature 03: the publication allow-list and replica tables gain `rules_section_marks`; sync tests list the class.
- Feature 06: audit-sync lists the class as without an audit query (Ownership Rule on read).
- App shell: `CampaignDashboard` mounts `RulesLibrary`, lists `rulesSearchContribution`, and offers `RulesPreview` in
  the wizard.

## Out of Scope

P1 and P2 (D-18), editing rules, house rules (feature 16), compendiums.
