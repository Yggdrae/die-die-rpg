# TechSpec: Session Mode

Source: `_prd.md`, `_bdd.md`, `_db.md`, `PRD.md` s.5.4, s.43, s.44, s.45, s.76, s.78, s.79; features 03, 04, 06, 07, 09,
11, 15, 16, 17. P0 only.

## Current Facts

- Feature 16 has the entity type `scene` and the relationship kinds `located_at` and `appears_in`. Entities and
  relationships reach a device only when its user may read them.
- Feature 16 ships `CONTENT_SESSION_QUICK_ACTIONS` (`content.add_npc`, `content.add_note`), and feature 17 ships
  `HANDOUT_SESSION_QUICK_ACTIONS` (`handouts.reveal`). Both implement the frozen `SessionQuickAction`, and their
  overlays are mounted once by the app shell.
- Features 09 and 11 replicate rolls and effect applications, already filtered by Visibility. Audit events whose
  target is a per-record class (entities included) stay online-only (feature 06 `campaign_scope_unprovable`), so a
  device cannot read reveal events locally.
- Feature 15 fixes a character's Visibility at `players:[owner]`. Packages declare `characterSchema.summaryFields` for
  party panels.
- Feature 20 (search) and feature 14 (rules) are not built. Feature 19 (encounters) is not built.

## Decisions (open PRD questions closed; delegated by the owner, 2026-11-03)

- **D-01 Package `@rpg/sessions`.** The root has records, codecs, the pure session model, policies, audit
  declarations, device repositories, and the export contributor. `/postgres` has the schema, the repository, and the
  service. The applier lives in `apps/api/src/modules/sessions`, the screens in `apps/web/src/features/sessions`.
- **D-02 Scenes are feature 16 entities (open question 1).** A session names its current scene by entity ID. Its
  location is the scene's `located_at` target, and its NPCs are the entities that `appear_in` it. The device resolves
  them from the feature 16 replica, so a player sees only what was revealed to them.
- **D-03 The session log is a device view (open question 2),** not a store of its own and not the audit log. It merges,
  in time order, this feature's log entries and the feature 09 rolls and feature 11 effect applications inside the
  session window. Every source is filtered at its own sync boundary, so the log cannot show what the device must not
  hold. Resource changes (`PRD.md` s.43) are the effect applications. Reveals made from Session Mode are log entries:
  feature 17's overlay reports a reveal with the session it was opened from, and the app shell writes the entry. A
  reveal made elsewhere is in the feature 06 audit trail only.
- **D-04 One open session per campaign.** The authority assigns the number (the campaign's highest plus one, under a
  campaign lock). The device shows a provisional number until the row is accepted. A start while another session is
  open is refused (`session_already_open`).
- **D-05 Lifecycle.** `active -> paused -> active`, and `active | paused -> ended`, which is final. The scene and the
  participants change while the session is open. Every change is a versioned update; a stale one is a feature 03
  conflict. Start, pause, resume, end, and scene changes each also write a log entry.
- **D-06 GM notes are one versioned text per session (`session_gm_notes`), `gm_only`.** A save names the version it
  edited, so a concurrent edit is an explicit feature 03 conflict (keep the authority's, resubmit mine), never a silent
  overwrite. Merging (`PRD.md` s.87 Test 5) waits for collaborative text (FR-203, V1). At most 20,000 characters.
- **D-07 The assistant GM shares the GM view entirely (open question 4).** Same capabilities as the GM on sessions,
  notes, and log entries.
- **D-08 Party panel.** Each character the device holds, with its package's `summaryFields` rendered by feature 15's
  `characterSummary` (additive export). GM roles see the whole party. A player sees their own character only: feature
  15 keeps characters private to their owner, and widening that to the party is a privacy change this feature does
  not make implicitly. A party-visible summary projection can be added by a later decision.
- **D-09 Participants.** At the start, the starter plus every character owner the device holds. The GM marks presence
  in the party panel while the session is open. Presence detection is V1.
- **D-10 Log entries are immutable.** `note` (1 to 500 characters, `gm_only` by default or `everyone` when the GM
  chooses), `scene` (the scene's ID, `everyone`, named on each device from its own replica), `status` (`started`,
  `paused`, `resumed`, `ended`, `everyone`), `reveal` (the revealed entity's ID, `gm_only`: recipients see the content
  itself). They carry no audit envelope: they are their own record.
- **D-11 Quick actions come from the app shell.** The shell passes `SessionQuickAction[]` to the session screen, which
  lists and invokes them with `{ actor, sessionId }` and imports none of the contributing features. An action with a
  `capability` shows only when the pinned system declares it. An action no feature registers does not appear.
  Encounters (feature 19) and clocks (V1) register later in the shell.
- **D-12 Command palette.** `Ctrl + K` (or `Cmd + K`) opens a dialog that matches labels across providers: the quick
  actions, the session's own operations (pause, resume, end, add a log note, set each scene the device holds as
  current), and entity lookups (selecting one shows its name, type, and summary in a lookup panel). Providers implement
  a local `PaletteProvider`; feature 20 and feature 14 contribute theirs through the shell when they exist.
  Implemented by feature 20 (its D-12): `paletteProviders` prop; with a provider the direct entity lookup gives way to
  the provider's results, and a provided entry naming an entity the session holds opens the lookup panel. Arrow keys
  move, Enter runs, Escape closes.
- **D-13 The player view is different data.** A player's replica holds the sessions, the entries visible to them, their
  own rolls and character, and revealed content, and never GM notes, `gm_only` entries, hidden rolls, or unrevealed
  entities. Encounter state is feature 19's.
- **D-14 Audit.** `session.started`, `session.paused`, `session.resumed`, `session.ended`, `session.scene_changed`, by
  the authority in the write transaction, with the mutation ID as origin. Notes and entries are not audited.
- **D-15 Export.** `SessionExporter` (`sessions`): sessions, GM notes, and entries, restored to the importer with
  participants and scenes mapped (`_db.md`).
- **D-16 The 2 second budget is a test.** Playwright opens Session Mode cold ten times with the network down over a warm
  replica and asserts p95 under 2,000 ms, from navigation to the usable screen. It replaces manual timing (owner rule).
- **D-17 Deferred.** Preparation checklist, recap, rules panel (P1); clocks, presence, collaborative notes (P2).

## Resource Policies

| Class | owner / gm / assistant_gm | player | observer | Visibility | Sync |
| --- | --- | --- | --- | --- | --- |
| `campaign_session` | read, create, update | read | none | fixed `everyone` | `campaign_sessions` |
| `session_gm_note` | read, create, update | none | none | fixed `gm_only` | `session_gm_notes` |
| `session_log_entry` | read, create | read | none | per entry (`gm_only`, `everyone`) | `session_log_entries` |

## Authority

`SessionService` (feature `sessions`, one applier per table):

- `campaign_sessions` insert: GM role, no open session, status `active`, no end. Number assigned, participants bounded.
  Audits `session.started`.
- `campaign_sessions` update: versioned. Only `status` (by a valid transition), `ended_at` (exactly when ending),
  `current_scene_id`, and `participant_user_ids` may change. Audits the transition or the scene change.
- `session_gm_notes` insert (once per session) and versioned update.
- `session_log_entries` insert: GM role, the session exists, kind rules from `_db.md`.
- Codes: `invalid_payload`, `invalid_session`, `session_already_open`, `not_found_or_forbidden` (terminal),
  `conflict` (stale version), `authority_unavailable` (retryable).

## Device

- `SessionLocalRepository`: `open()`, `list()`, `start()`, `pause()`, `resume()`, `end()`, `setScene()`,
  `setPresent()`, each writing the session and its log entry.
- `SessionNotesLocalRepository`: `get()`, `save(body, expectedVersion)`. `SessionLogLocalRepository`: `add()`,
  `list()`.
- Pure model (`domain.ts`): transitions, provisional number, `sceneContext`, `sessionLog`, palette matching.
- Web: `SessionWorkspace` (GM screen and player view), `CommandPalette`, `session-source.ts` over the browser replica.
  Mounted in `CampaignDashboard` with the shell's quick actions.

## Test Strategy

- Unit: transitions, numbering, scene context, log merge, palette matching, summaries on all three packages, device
  repositories, static markup of every region.
- PostgreSQL: matrix, numbering, one open session, transitions, conflict, notes `gm_only`, entry rules, audit once on
  retry, export and import.
- Live PowerSync: a player receives the session and the public entry, never the notes or the `gm_only` entry.
- E2E: start and run a session from one screen, quick actions and palette without leaving it, a reveal from Session
  Mode in under 5 seconds, the player view, a whole offline session, the cold offline p95.

## Changes in Other Features (additive)

- Feature 15: `characterSummary(system, state)` renders `summaryFields` as text, GM-only fields excluded.
- Feature 16: `SCENE_ENTITY_TYPE`, `LOCATED_AT_KIND`, `APPEARS_IN_KIND` in `types.ts`, so no other package names a type.
- Feature 17: `HandoutsWorkspace` and `HandoutRevealHost` take an optional `onRevealed`, called after a reveal is written
  locally. The overlay passes the session it was opened from; the app shell writes the `reveal` entry.
- Feature 07: the `sessions` module in the server and device exports (`entities/sessions.json`).
- Feature 06: the `session` contributor row is built. Session audit history stays online-only
  (`campaign_scope_unprovable`), like other per-record classes.
- Feature 03: the holds stream gains branches for the two new updatable classes (derived from the declarations; no
  hold is used in P0).
- App shell: `CampaignDashboard` mounts Session Mode with `CONTENT_SESSION_QUICK_ACTIONS` and
  `HANDOUT_SESSION_QUICK_ACTIONS`.

## Out of Scope

P1 and P2 (D-17), encounters (feature 19), entity and rules search (features 20 and 14), a VTT, voice, presence.
