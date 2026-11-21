# Task 12: Web quick create, editor, holds, visibility controls, session quick actions

Status: completed (2026-10-30)

## Goal

Capture an entity from a name in seconds, edit it with explicit conflicts and a single-writer
description, reveal it through the mounted feature 04 controls, and offer quick create as
`SessionQuickAction`s without a frozen-contract change.

## Dependencies

- Tasks 06, 11.

## Context

- TechSpec: `../_techspec.md` "Web", "Offline and Synchronization"; D-09 (one field = summary,
  default type `note`), D-10 (Markdown source in a textarea, plain-text display), D-14 / B-4
  (quick actions open feature 16's own overlay), D-17 (local draft until a hold is held).
- Hand-over: `VisibilityControls` has no production mount; first content owner mounts it
  (props `campaignId, resourceClass, resourceId, visibility, version, viewerRole, onChanged,
  onReload`); 409 carries no current version, so the host refetches.
- Holds client: `apps/web/src/features/sync/hold-client.ts`; conflict surface: `ConflictSurface`
  in `SyncStatus.tsx`; purge hook: feature 03 `ReplicaPurgeListener`.
- Frozen `SessionQuickAction` (`packages/contracts/src/registries.ts`): `invoke({ actor,
  sessionId }): Promise<void>`, no input.
- Guard `no-local-role-checks`: no role literal in feature 16 web code.

## Scope

### Change

- `QuickCreate` (name input focused, optional summary, Enter saves, type from entry point,
  default `note`) writing through `EntityLocalRepository.quickCreate`.
- `EntityEditor` for name, type, summary, tags (with suggestions from local visible rows);
  `DescriptionEditor` (textarea) acquiring/renewing/releasing holds, takeover notice. Text typed
  without a current hold (offline, expired, taken over) is kept in a device-local, unsynchronized
  draft store keyed by campaign/class/record/field, never queued, and cleared through a feature 03
  `ReplicaPurgeListener` (revocation, campaign deletion, sign-out).
- Mount `VisibilityControls` on entity detail; refetch on `onReload`.
- `PersonalNotes` list/editor for players (title + body with the same hold/draft editor; no
  visibility controls, no attachments, no links).
- Affordance hints (which entry points and controls appear) from the registered declarations and
  the cached membership role, never a role literal; if that needs a role comparison in web code,
  add one reasoned `LOCAL_ROLE_CHECK_ALLOWED` entry as `visibility-model.ts` did. The authority
  re-decides every write.
- Session quick actions (D-14): `CONTENT_SESSION_QUICK_ACTIONS` (`content.add_npc` -> type `npc`,
  `content.add_note` -> type `note`) implementing the frozen `SessionQuickAction`; `invoke` opens
  `ContentQuickCreateHost` and resolves when the overlay closes (saved or cancelled), never
  throwing on cancel. The app shell mounts `ContentQuickCreateHost` once. Placing the actions on
  the Session Mode screen is feature 18's work.
- Playwright: quick create from name only; reveal to one player; conflict then keep/resubmit;
  takeover keeps the previous holder's draft; offline description draft saved after reconnect.

### Do Not Change

- `VisibilityControls`, hold client, conflict surface internals; `packages/contracts`.

## Acceptance Criteria

- [x] Quick create saves with only a name; no other control is required; generic entry point
  yields type `note`; local write visible immediately offline.
- [x] Stale edit shows the conflict surface with both values; nothing is overwritten silently.
- [x] Description cannot be saved without a hold; takeover notifies and keeps unsaved text; an
  offline draft survives reload and is saved under a hold after reconnect; sign-out removes it.
- [x] Visibility controls appear on entities only, never on personal notes.
- [x] Invoking `content.add_npc` with a test `{ actor, sessionId }` opens the overlay and the
  promise resolves on save and on cancel; no feature 18 code is imported or required.
- [x] Scripted quick-create flow measured; result recorded for task 16's manual 30 s check.

## Verification

```bash
bun test apps/web/src/features/content
bun x playwright test apps/web/e2e/content.e2e.ts
bun run typecheck
bun run guard
bun run build
```

## Evidence (2026-10-30)

- Quick create: `QuickCreateForm` (name autofocus, optional summary, Enter saves), entry points
  `QUICK_CREATE_ENTRY_POINTS` (Add NPC / Add location / Add note) plus a generic "New entity" (default
  `note`) from `packages/content/src/types.ts`; writes through `EntityLocalRepository.quickCreate`.
- `EntityEditor` (name, type, summary, tags with datalist suggestions from visible rows);
  `LongTextEditor` for descriptions and note bodies: acquire/renew (feature 03 `HoldRenewalController`)
  /release via `hold-api.ts`, takeover, save only while held (renew first); a takeover is noticed
  through the replicated hold row (newer version) or at save at the latest. Every keystroke is kept in
  `ContentDraftStore` (`localStorage`, per user, keyed campaign|class|record|field, never queued), a
  feature 03 `ReplicaPurgeListener` in `useBrowserSync`, cleared on sign-out. After a held save the
  hold is kept until the queued write leaves the device (`settleHeldWrite`) and the draft is dropped
  only when the write is accepted (found live: releasing on close made the authority answer
  `hold_required`).
- `VisibilityControls` mounted on entity detail (server result shown until the replica catches up;
  `onReload` refetches `GET /campaigns/:c/entities/:id`); `PersonalNotes` (title + held body; no
  Visibility, attachments, or links); conflicts through the feature 03 `ConflictSurface` with keep
  authority / resubmit mine / decide later (browser resolution added to `browser.ts`; resubmit keeps
  the authority Visibility).
- Affordances: `contentAffordances(role)` reads `roleCapabilities` of the registered policies for the
  cached role (no role literal; no `LOCAL_ROLE_CHECK_ALLOWED` entry needed).
- D-14: `CONTENT_SESSION_QUICK_ACTIONS` (`content.add_npc`, `content.add_note`, frozen
  `SessionQuickAction`), `ContentQuickCreateHost` mounted once in `CampaignDashboard`; `invoke` resolves
  on save and on cancel and never throws (also without a host).
- Tests: `content-support.test.ts` 7 (drafts, hold client, quick actions) plus the views/model tests.
- Playwright `content.e2e.ts` (9 tests, real stack): quick create from name only (+ generic -> note,
  offline visible at once and pending); reveal to one player (Casey sees it, Dana does not; no controls
  for players); conflict -> resubmit, then conflict -> keep authority; takeover keeps Avery's text and
  draft across reload while Blake saves; offline draft never queued, survives reload, saved under a hold
  after reconnect, sign-out removes drafts; session quick action save/cancel; player note.
- Scripted quick-create measurement (for task 16's manual 30 s check): Add NPC -> name -> Enter listed
  locally in 277 ms; accepted and synchronized in 1,101 ms (Edge headless, local stack).
- Focused: `bun test apps/web/src/features/content` 27 pass; `bun x playwright test
  apps/web/e2e/content.e2e.ts` 9 passed (three full runs).

Gates (with `.env`, 2026-10-30): `bun run check` clean (462 files); `bun run typecheck` 13/13
exit 0; `bun run guard` 412 files, no violations; `bun run build` api + web exit 0;
`bun test --timeout 30000` 1406 pass, 8 skip, 1 fail (MinIO read-URL expiry, a known timing flake;
`packages/attachments/src/infra/s3` alone 10/10); the 8 engine-gated sync tests pass with
`POWERSYNC_ENGINE_EXEC` (`apps/api/src/modules/sync` 79/79); `bun run test:e2e` 72 passed, 1 failed
(live-sync "queued writes of a revoked member", the known flake; `live-sync.e2e.ts` alone 9/9).
