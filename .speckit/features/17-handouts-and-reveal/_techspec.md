# TechSpec: Handouts and Reveal

Source: `_prd.md`, `_bdd.md`, `_db.md`, `PRD.md` s.34, s.35, s.76, s.78, s.87 Test 3; features 03, 04, 05, 06, 16. P0 only.

## Current Facts

- Feature 16 stores every entity type in `content_entities`, streams it by Visibility (`authorized_content`), and
  already proves at payload level that a revealed entity reaches player A only (`sync-config.powersync.integration.test.ts`).
- Feature 04 `VisibilityService.change` re-decides `reveal`, compares the version, checks targets, writes through the
  owner's adapter, and records `visibility.revealed` / `visibility.unrevealed` in the same transaction. Today it is
  reached only by `PATCH .../visibility`, which needs a connection.
- Feature 16 entity updates refuse a visibility change (`visibility_change_not_allowed`).
- Feature 05 decides an attachment as its owner's decision AND the owner declaration under the attachment's own
  Visibility. Feature 16 uploads an attachment with the entity's Visibility at upload time, so an image uploaded while
  hidden would stay hidden after a reveal.
- Party targeting is inactive in feature 04 (no party resolver). The member list is HTTP only.

## Decisions (open PRD questions closed; delegated by the owner, 2026-11-03)

- **D-01 A handout is a feature 16 entity type (open question 1).** `handout` is added to `ENTITY_TYPES`: title is
  `name`, body is `description` (Markdown source, feature 16 D-10), default `gm_only`. Lists, filters, search, export,
  import, attachments, holds, and conflicts are feature 16's, unchanged. No table, no migration.
- **D-02 Un-reveal is in P0 (open question 2),** as feature 04 already supports it. The screen states its limit with
  feature 04's `UNREVEAL_LIMITATION`. Nothing implies it is an undo.
- **D-03 Reveal is a queued sync mutation (open question 3).** The GM device writes the entity with its new Visibility
  plus a transport-only `visibilityChange: { operation, target }`, without an audit envelope. The feature 16 applier
  passes it to `VisibilityService.change` (mutation ID as audit origin). Online it applies in one round trip. Offline
  it waits in the GM's queue: the GM sees "Waiting to send", and players see nothing, because anything on a player
  device before the reveal is a leak. On reconnect it applies once (feature 03 receipts, feature 06 origin dedupe). This
  path is open to every entity type with exactly the HTTP route's rules. Only the handout screen uses it in P0.
- **D-04 The reveal names the previewed version.** `expectedVersion` is the version the GM previewed. A concurrent edit
  is a feature 03 conflict: nothing is revealed, and the GM reviews and reveals again (`_prd.md` risk "wrong reveal").
- **D-05 Recipients are everyone or named players.** Party is shown unavailable (feature 04 `PARTY_UNAVAILABLE`) until
  parties exist. Named players need the member list, loaded while online and kept in memory. A GM who starts offline can
  still reveal to everyone. The confirm button names the recipients.
- **D-06 Attachments follow the handout.** Attachments on a handout are uploaded with their own Visibility `everyone`, so
  feature 05's intersection equals the handout's audience as it is revealed and hidden. There is no second write and
  no window where they disagree. Other entity types keep feature 16's behavior.
- **D-07 Who has it is the current Visibility.** Read receipts and a staged reveal order are P1. The history is the
  feature 06 audit trail. Its payload carries the recipients' IDs, and its text renders a count.
- **D-08 Session Mode.** Feature 16's session quick-action pattern (D-14): a `SessionQuickAction` "Reveal handout" opens
  the handout overlay mounted by the app shell. Placing it on the session screen is feature 18's.
- **D-09 Player view.** A "Handouts" list shows the handouts the device holds, most recently changed first, readable
  offline. It appears as the stream delivers them, with no refresh.
- **D-10 The 5 second budget is a test,** measured by Playwright from the GM's confirm to the text on the recipient's
  screen, through the real API and PowerSync. It replaces any manual timing (owner rule).

## Authority

`EntitySyncMutationApplier`, update with `visibilityChange`:

- Requires no audit envelope (`invalid_payload` otherwise) and a version.
- Calls `VisibilityService.change(actor.userId, { campaignId, resourceClass: 'campaign_entity', resourceId, operation,
  target, expectedVersion, mutationId })`. The payload's own Visibility and other fields are ignored: the server
  computes the result.
- `changed`, `unchanged`: accepted at the stored version. `conflict`: a feature 03 conflict with the current record.
  `not_found`, `denied`, `actor_not_member`, `unknown_resource_class`: `not_found_or_forbidden`. Target and value
  rejections: `invalid_visibility`. Faults: `authority_unavailable` (retryable).

## Device

- `EntityLocalRepository.changeVisibility(id, change, expectedVersion)` computes the result with feature 04's
  `applyVisibilityChange` and writes through an unaudited repository over the same table. `visibilityChange` is
  transport-only, stripped from stored records like `holdVersion`.
- `apps/web/src/features/handouts`: `handout-model.ts` (pure), `HandoutsWorkspace.tsx` (GM list, preview, reveal dialog,
  un-reveal; player list and reader), the reveal overlay host, and `session-quick-actions.ts`.

## Test Strategy

- Unit: model (state, recipients, confirm text, pending), device `changeVisibility`, static markup of every view.
- PostgreSQL: the queued reveal path. Accepted and audited once on retry, player refused, stale version a conflict,
  non-member target refused, un-reveal.
- Live PowerSync: a handout revealed through `/sync/mutations` reaches player A only, then leaves on un-reveal.
- E2E: reveal to A in under 5 s, B's local database without the row, an image readable by A only, offline GM reveal
  delivered on reconnect, a player reading offline.

## Out of Scope

Read receipts, staged reveals, partial reveals (P1). Editable handouts, knowledge reveals, realtime effects (P2).
